from collections import Counter
from datetime import timedelta

from odoo import _, fields, http
from odoo.exceptions import UserError
from odoo.http import request
from odoo.tools import html2plaintext

ASSET_VERSION = "1.0.0"
OPEN_LIMIT = 500
CLOSED_LIMIT = 60
TREND_DAYS = 14
AGING_DAYS = 7


class QcFlightDeck(http.Controller):

    # ------------------------------------------------------------------
    # Page
    # ------------------------------------------------------------------
    @http.route("/qc-deck", type="http", auth="user")
    def deck_page(self, **kwargs):
        user = request.env.user
        return request.render("eas_qc_flight_deck.deck_page", {
            "can_read": self._can_read(),
            "uid": user.id,
            "user_name": user.name,
            "company_name": request.env.company.name,
            "asset_version": ASSET_VERSION,
        })

    # ------------------------------------------------------------------
    # JSON API (runs with the logged-in user's access rights and record rules)
    # ------------------------------------------------------------------
    @http.route("/qc-deck/data", type="json", auth="user")
    def deck_data(self, team_id=None):
        Alert = request.env["quality.alert"]
        now = fields.Datetime.now()
        base = [("team_id", "=", int(team_id))] if team_id else []
        open_dom = base + [("stage_id.done", "=", False)]
        done_dom = base + [("stage_id.done", "=", True)]

        open_alerts = Alert.search(open_dom, order="priority desc, create_date asc", limit=OPEN_LIMIT)
        closed_30 = Alert.search(
            done_dom + [("date_close", ">=", now - timedelta(days=30))],
            order="date_close desc",
        )
        closed_recent = closed_30.filtered(
            lambda a: a.date_close >= now - timedelta(days=TREND_DAYS)
        )[:CLOSED_LIMIT]

        durations = [
            (a.date_close - a.create_date).total_seconds() / 3600.0
            for a in closed_30 if a.date_close and a.create_date
        ]
        kpis = {
            "open": Alert.search_count(open_dom),
            "critical": Alert.search_count(open_dom + [("priority", "=", "3")]),
            "high": Alert.search_count(open_dom + [("priority", "=", "2")]),
            "unassigned": Alert.search_count(open_dom + [("user_id", "=", False)]),
            "aging": Alert.search_count(
                open_dom + [("create_date", "<", now - timedelta(days=AGING_DAYS))]
            ),
            "closed_7d": len(closed_30.filtered(
                lambda a: a.date_close >= now - timedelta(days=7)
            )),
            "mttr_hours": round(sum(durations) / len(durations), 1) if durations else None,
        }

        stages = request.env["quality.alert.stage"].search([])
        teams = request.env["quality.alert.team"].search([])

        return {
            "server_time": self._iso(now),
            "aging_days": AGING_DAYS,
            "kpis": kpis,
            "stages": [
                {"id": s.id, "name": s.name, "done": bool(s.done)} for s in stages
            ],
            "teams": [{"id": t.id, "name": t.name} for t in teams],
            "alerts": [self._alert_vals(a, now) for a in open_alerts + closed_recent],
            "trend": self._trend(Alert, base, closed_30, now),
            "top_products": self._top(open_alerts, lambda a: a.product_id or a.product_tmpl_id),
            "top_reasons": self._top(open_alerts, lambda a: a.reason_id),
            "leaderboard": self._top(closed_30, lambda a: a.user_id, limit=5),
        }

    @http.route("/qc-deck/alert/stage", type="json", auth="user")
    def alert_set_stage(self, alert_id, stage_id):
        alert = self._get_alert(alert_id)
        stage = request.env["quality.alert.stage"].browse(int(stage_id)).exists()
        if not stage:
            raise UserError(_("This stage no longer exists."))
        alert.write({"stage_id": stage.id})
        return self._alert_vals(alert, fields.Datetime.now())

    @http.route("/qc-deck/alert/assign", type="json", auth="user")
    def alert_assign_me(self, alert_id):
        alert = self._get_alert(alert_id)
        alert.write({"user_id": request.env.uid})
        return self._alert_vals(alert, fields.Datetime.now())

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------
    def _can_read(self):
        Alert = request.env["quality.alert"]
        if hasattr(Alert, "has_access"):  # Odoo 18+
            return Alert.has_access("read")
        return Alert.check_access_rights("read", raise_exception=False)

    def _get_alert(self, alert_id):
        alert = request.env["quality.alert"].browse(int(alert_id)).exists()
        if not alert:
            raise UserError(_("This quality alert no longer exists."))
        return alert

    @staticmethod
    def _iso(dt):
        return dt.strftime("%Y-%m-%dT%H:%M:%SZ") if dt else False

    @staticmethod
    def _text(value):
        return (html2plaintext(value).strip() if value else "") or ""

    @staticmethod
    def _top(records, key, limit=6):
        counter = Counter()
        for rec in records:
            target = key(rec)
            if target:
                counter[target.display_name] += 1
        return [{"name": name, "count": count} for name, count in counter.most_common(limit)]

    def _trend(self, Alert, base, closed_30, now):
        """Opened vs closed per day (user timezone) for the last TREND_DAYS days."""
        user = request.env.user
        today = fields.Datetime.context_timestamp(user, now).date()
        days = [today - timedelta(days=i) for i in range(TREND_DAYS - 1, -1, -1)]
        start = now - timedelta(days=TREND_DAYS + 1)
        opened = Counter(
            fields.Datetime.context_timestamp(user, a.create_date).date()
            for a in Alert.search(base + [("create_date", ">=", start)])
        )
        closed = Counter(
            fields.Datetime.context_timestamp(user, a.date_close).date()
            for a in closed_30 if a.date_close
        )
        return [
            {"day": d.isoformat(), "opened": opened.get(d, 0), "closed": closed.get(d, 0)}
            for d in days
        ]

    def _alert_vals(self, alert, now):
        def opt(field):
            # Fields contributed by optional modules / differing Odoo versions.
            return alert[field] if field in alert._fields else False

        product = alert.product_id or alert.product_tmpl_id
        lot = opt("lot_id")
        workcenter = opt("workcenter_id")
        picking = opt("picking_id")
        created = alert.create_date
        return {
            "id": alert.id,
            "name": alert.name or "",
            "title": opt("title") or "",
            "priority": int(alert.priority or 0),
            "stage_id": alert.stage_id.id,
            "done": bool(alert.stage_id.done),
            "product": product.display_name if product else "",
            "lot": lot.display_name if lot else "",
            "team": alert.team_id.display_name or "",
            "user_id": alert.user_id.id or False,
            "user": alert.user_id.name or "",
            "reason": alert.reason_id.display_name or "",
            "tags": alert.tag_ids.mapped("display_name"),
            "partner": alert.partner_id.display_name or "",
            "workcenter": workcenter.display_name if workcenter else "",
            "picking": picking.display_name if picking else "",
            "description": self._text(alert.description),
            "corrective": self._text(opt("action_corrective")),
            "preventive": self._text(opt("action_preventive")),
            "created": self._iso(created),
            "closed": self._iso(alert.date_close),
            "age_hours": round((now - created).total_seconds() / 3600.0, 1) if created else 0,
        }
