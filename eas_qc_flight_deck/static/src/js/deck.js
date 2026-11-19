(function () {
    "use strict";

    const REFRESH_MS = 30000;
    const PRIORITY = { 0: "ROUTINE", 1: "LOW", 2: "HIGH", 3: "CRITICAL" };
    const root = document.getElementById("deck");
    if (!root) return;

    const state = {
        uid: Number(root.dataset.uid),
        data: null,
        team: "",
        prio: "",
        query: "",
        selected: null,
        known: null,      // Set of alert ids seen on previous refresh
        fresh: new Set(), // ids that appeared since the previous refresh
        sound: false,
        dragging: false,
    };

    // ------------------------------------------------------------ utils
    const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => (
        { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
    const $ = (sel) => root.querySelector(sel);

    async function rpc(url, params) {
        const res = await fetch(url, {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: params || {} }),
        });
        if (!res.ok) throw new Error("Server returned HTTP " + res.status);
        const body = await res.json();
        if (body.error) {
            const data = body.error.data || {};
            throw new Error(data.message || body.error.message || "Server error");
        }
        return body.result;
    }

    function fmtAge(hours) {
        if (hours < 1) return Math.max(1, Math.round(hours * 60)) + "m";
        if (hours < 48) return Math.round(hours) + "h";
        return Math.round(hours / 24) + "d";
    }
    const fmtDate = (iso) => iso ? new Date(iso).toLocaleString([], {
        day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
    }) : "—";

    function toast(msg, isErr) {
        document.querySelectorAll(".fd-toast").forEach((n) => n.remove());
        const el = document.createElement("div");
        el.className = "fd-toast" + (isErr ? " is-err" : "");
        el.setAttribute("role", "status");
        el.textContent = msg;
        document.body.appendChild(el);
        setTimeout(() => el.remove(), isErr ? 6000 : 2500);
    }

    function beep() {
        try {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = "square";
            osc.frequency.value = 880;
            gain.gain.value = 0.05;
            osc.connect(gain).connect(ctx.destination);
            osc.start();
            osc.stop(ctx.currentTime + 0.25);
            osc.onended = () => ctx.close();
        } catch (e) { /* audio unavailable */ }
    }

    // ------------------------------------------------------------ shell
    root.innerHTML = `
      <header class="fd-head">
        <div class="fd-brand">
          <svg viewBox="0 0 40 40" aria-hidden="true">
            <circle cx="20" cy="20" r="17" fill="none" stroke="#35e0ff" stroke-width="1.5" opacity=".5"/>
            <circle cx="20" cy="20" r="10" fill="none" stroke="#35e0ff" stroke-width="1.5"/>
            <path d="M20 1v9M20 30v9M1 20h9M30 20h9" stroke="#35e0ff" stroke-width="1.5"/>
            <circle cx="20" cy="20" r="2.5" fill="#35e0ff"/>
          </svg>
          <div>
            <h1>QC FLIGHT DECK</h1>
            <div class="fd-label">Non-conformance control · ${esc(root.dataset.company)}</div>
          </div>
        </div>
        <input class="fd-input" id="fd-q" type="search" placeholder="Search NC, product, lot…" aria-label="Search alerts">
        <select class="fd-input" id="fd-team" aria-label="Quality team"><option value="">All teams</option></select>
        <select class="fd-input" id="fd-prio" aria-label="Priority">
          <option value="">All priorities</option>
          <option value="3">Critical</option><option value="2">High</option>
          <option value="1">Low</option><option value="0">Routine</option>
        </select>
        <div class="fd-sync" id="fd-sync"><i></i><span>Linking…</span></div>
        <button class="fd-btn" id="fd-sound" type="button" aria-pressed="false">Sound off</button>
        <button class="fd-btn" id="fd-full" type="button">Fullscreen</button>
        <a class="fd-btn" href="/web">Exit</a>
        <div class="fd-clock" id="fd-clock"></div>
      </header>
      <section class="fd-kpis" id="fd-kpis" aria-label="Key figures"></section>
      <section class="fd-main">
        <div class="fd-lanes" id="fd-lanes"></div>
        <aside class="fd-side" id="fd-side"></aside>
      </section>
      <aside class="fd-drawer" id="fd-drawer" aria-label="Alert details"></aside>`;

    // ------------------------------------------------------------ render
    function visibleAlerts() {
        const q = state.query.trim().toLowerCase();
        return state.data.alerts.filter((a) => {
            if (state.prio !== "" && a.priority !== Number(state.prio)) return false;
            if (!q) return true;
            return [a.name, a.title, a.product, a.lot, a.user, a.reason, a.partner]
                .join(" ").toLowerCase().includes(q);
        });
    }

    function renderKpis() {
        const k = state.data.kpis;
        const level = k.critical ? "red" : (k.aging || k.unassigned || k.high) ? "amber" : "green";
        const word = { red: "RED ALERT", amber: "CAUTION", green: "ALL CLEAR" }[level];
        const note = {
            red: k.critical + " critical NC open",
            amber: "Items need attention",
            green: "No critical or aging NC",
        }[level];
        const mttr = k.mttr_hours == null ? "—" : fmtAge(k.mttr_hours);
        const tile = (label, value, sub, cls) => `
          <div class="fd-panel fd-kpi ${cls || ""}">
            <div class="fd-label">${label}</div><b>${esc(value)}</b><small>${sub}</small>
          </div>`;
        $("#fd-kpis").innerHTML = `
          <div class="fd-panel fd-kpi fd-status is-${level}">
            <div class="fd-label">Quality status</div><b>${word}</b><small>${note}</small>
          </div>` +
          tile("Open NC", k.open, "awaiting closure") +
          tile("Critical", k.critical, "very high priority", k.critical ? "is-red" : "is-green") +
          tile("High", k.high, "high priority", k.high ? "is-amber" : "") +
          tile("Unassigned", k.unassigned, "no owner yet", k.unassigned ? "is-amber" : "is-green") +
          tile("Aging", k.aging, "open &gt; " + state.data.aging_days + " days", k.aging ? "is-amber" : "is-green") +
          tile("Closed 7d", k.closed_7d, "avg time to close " + mttr, "is-green");
    }

    function cardHtml(a) {
        const old = !a.done && a.age_hours > state.data.aging_days * 24;
        return `
          <button type="button" class="fd-card p${a.priority}${a.done ? " is-done" : ""}${state.fresh.has(a.id) ? " is-new" : ""}"
                  data-id="${a.id}" draggable="true">
            <div class="fd-card-top">
              <span>${esc(a.name)}</span>
              <span class="fd-tag p${a.priority}">${PRIORITY[a.priority] || "ROUTINE"}</span>
            </div>
            <h3>${esc(a.title || a.reason || "Quality alert")}</h3>
            <p>${esc(a.product || "No product")}${a.lot ? " · " + esc(a.lot) : ""}</p>
            <div class="fd-card-foot">
              <span class="${a.user ? "" : "fd-unassigned"}">${esc(a.user || "Unassigned")}</span>
              <span class="fd-age${old ? " is-old" : ""}">${a.done ? "closed " + esc(fmtDate(a.closed)) : fmtAge(a.age_hours) + " open"}</span>
            </div>
          </button>`;
    }

    function renderLanes() {
        const alerts = visibleAlerts();
        $("#fd-lanes").innerHTML = state.data.stages.map((s) => {
            const items = alerts.filter((a) => a.stage_id === s.id);
            return `
              <div class="fd-lane${s.done ? " is-done" : ""}" data-stage="${s.id}">
                <div class="fd-lane-head">
                  <div class="fd-label">${esc(s.name)}${s.done ? " · 14d" : ""}</div><span>${items.length}</span>
                </div>
                <div class="fd-lane-body">
                  ${items.map(cardHtml).join("") || '<div class="fd-empty">No alerts</div>'}
                </div>
              </div>`;
        }).join("") || '<div class="fd-empty">No quality alert stages configured.</div>';
    }

    function trendSvg(trend) {
        const W = 290, H = 96, pad = 16;
        const max = Math.max(1, ...trend.map((d) => Math.max(d.opened, d.closed)));
        const slot = W / trend.length, bw = Math.max(3, slot / 2 - 3);
        const bars = trend.map((d, i) => {
            const x = i * slot + 2;
            const ho = (d.opened / max) * (H - pad - 4), hc = (d.closed / max) * (H - pad - 4);
            const day = d.day.slice(8);
            return `<g><title>${d.day}: ${d.opened} opened, ${d.closed} closed</title>
              <rect x="${x}" y="${H - pad - ho}" width="${bw}" height="${ho}" fill="#ffb020"/>
              <rect x="${x + bw + 1}" y="${H - pad - hc}" width="${bw}" height="${hc}" fill="#3dffa0"/>
              ${i % 2 === 1 ? `<text x="${x + bw}" y="${H - 3}" fill="#7089a8" font-size="9" text-anchor="middle">${day}</text>` : ""}</g>`;
        }).join("");
        return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Opened versus closed alerts per day">
          <line x1="0" x2="${W}" y1="${H - pad}" y2="${H - pad}" stroke="rgba(53,224,255,.3)"/>${bars}</svg>`;
    }

    function rankHtml(rows, cls) {
        if (!rows.length) return '<div class="fd-empty">No data</div>';
        const max = rows[0].count || 1;
        return `<div class="fd-rank ${cls}">` + rows.map((r) => `
          <div><div class="n" title="${esc(r.name)}">${esc(r.name)}</div>
               <div class="bar" style="width:${Math.max(4, (r.count / max) * 100)}%"></div></div>
          <div class="c">${r.count}</div>`).join("") + "</div>";
    }

    function renderSide() {
        const d = state.data;
        $("#fd-side").innerHTML = `
          <div class="fd-panel fd-box"><h2>Traffic · last ${d.trend.length} days</h2>${trendSvg(d.trend)}
            <div class="fd-legend"><span><i style="background:#ffb020"></i>Opened</span><span><i style="background:#3dffa0"></i>Closed</span></div></div>
          <div class="fd-panel fd-box"><h2>Top offenders · open NC by product</h2>${rankHtml(d.top_products, "")}</div>
          <div class="fd-panel fd-box"><h2>Root causes · open NC</h2>${rankHtml(d.top_reasons, "is-cyan")}</div>
          <div class="fd-panel fd-box"><h2>Top resolvers · 30 days</h2>${rankHtml(d.leaderboard, "is-green")}</div>`;
    }

    function renderDrawer() {
        const drawer = $("#fd-drawer");
        const a = state.data && state.data.alerts.find((x) => x.id === state.selected);
        if (!a) { drawer.classList.remove("is-open"); drawer.innerHTML = ""; return; }
        const row = (label, value) => value ? `<dt>${label}</dt><dd>${esc(value)}</dd>` : "";
        const block = (label, text) => text ? `<div><div class="fd-label">${label}</div><p class="fd-text">${esc(text)}</p></div>` : "";
        const stage = state.data.stages.find((s) => s.id === a.stage_id);
        drawer.innerHTML = `
          <div class="fd-drawer-head">
            <div><span class="fd-tag p${a.priority}">${PRIORITY[a.priority]}</span>
              <span class="fd-label">&nbsp;${esc(a.name)}</span>
              <h2>${esc(a.title || a.reason || "Quality alert")}</h2></div>
            <button class="fd-btn" type="button" data-act="close" aria-label="Close details">Close</button>
          </div>
          <div class="fd-drawer-body">
            <dl class="fd-dl">
              ${row("Stage", stage && stage.name)}${row("Product", a.product)}${row("Lot / Serial", a.lot)}
              ${row("Root cause", a.reason)}${row("Owner", a.user || "Unassigned")}${row("Team", a.team)}
              ${row("Vendor", a.partner)}${row("Work center", a.workcenter)}${row("Transfer", a.picking)}
              ${row("Tags", a.tags.join(", "))}${row("Raised", fmtDate(a.created))}
              ${row(a.done ? "Closed" : "Open for", a.done ? fmtDate(a.closed) : fmtAge(a.age_hours))}
            </dl>
            ${block("Description", a.description)}${block("Corrective action", a.corrective)}${block("Preventive action", a.preventive)}
            <div><div class="fd-label">Move to stage</div>
              <div class="fd-actions" style="margin-top:8px">
                ${state.data.stages.map((s) => `<button type="button" class="fd-btn${s.id === a.stage_id ? " is-on" : ""}"
                    data-act="stage" data-stage="${s.id}" ${s.id === a.stage_id ? "disabled" : ""}>${esc(s.name)}</button>`).join("")}
              </div></div>
          </div>
          <div class="fd-drawer-foot">
            ${a.user_id === state.uid ? "" : '<button type="button" class="fd-btn is-primary" data-act="assign">Assign to me</button>'}
            <a class="fd-btn" href="/web#id=${a.id}&model=quality.alert&view_type=form" target="_blank" rel="noopener">Open in Odoo</a>
          </div>`;
        drawer.classList.add("is-open");
    }

    function renderAll() {
        renderKpis(); renderLanes(); renderSide(); renderDrawer();
    }

    // ------------------------------------------------------------ data
    function setSync(cls, text) {
        const el = $("#fd-sync");
        el.className = "fd-sync " + cls;
        el.lastElementChild.textContent = text;
    }

    async function refresh() {
        if (state.dragging) return;
        setSync("is-busy", "Syncing");
        try {
            const data = await rpc("/qc-deck/data", { team_id: state.team || null });
            const ids = new Set(data.alerts.filter((a) => !a.done).map((a) => a.id));
            state.fresh = new Set(state.known ? [...ids].filter((id) => !state.known.has(id)) : []);
            state.known = ids;
            state.data = data;
            const sel = $("#fd-team");
            if (sel.options.length === 1) {
                data.teams.forEach((t) => sel.add(new Option(t.name, t.id)));
            }
            renderAll();
            if (state.sound && data.alerts.some((a) => state.fresh.has(a.id) && a.priority >= 2)) beep();
            setSync("", "Live · " + new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
        } catch (err) {
            setSync("is-err", "Link lost");
            if (!state.data) toast(err.message, true);
        }
    }

    async function act(url, params, okMsg) {
        try {
            await rpc(url, params);
            toast(okMsg);
        } catch (err) {
            toast(err.message, true);
        }
        await refresh();
    }
    const moveStage = (id, stageId) => {
        const s = state.data.stages.find((x) => x.id === stageId);
        return act("/qc-deck/alert/stage", { alert_id: id, stage_id: stageId }, "Moved to " + (s ? s.name : "stage"));
    };

    // ------------------------------------------------------------ events
    $("#fd-q").addEventListener("input", (e) => { state.query = e.target.value; renderLanes(); });
    $("#fd-prio").addEventListener("change", (e) => { state.prio = e.target.value; renderLanes(); });
    $("#fd-team").addEventListener("change", (e) => { state.team = e.target.value; state.known = null; refresh(); });
    $("#fd-full").addEventListener("click", () => {
        if (document.fullscreenElement) document.exitFullscreen();
        else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen();
    });
    $("#fd-sound").addEventListener("click", (e) => {
        state.sound = !state.sound;
        e.target.textContent = state.sound ? "Sound on" : "Sound off";
        e.target.classList.toggle("is-on", state.sound);
        e.target.setAttribute("aria-pressed", String(state.sound));
        if (state.sound) beep();
    });

    const lanes = $("#fd-lanes");
    lanes.addEventListener("click", (e) => {
        const card = e.target.closest(".fd-card");
        if (card) { state.selected = Number(card.dataset.id); renderDrawer(); }
    });
    lanes.addEventListener("dragstart", (e) => {
        const card = e.target.closest(".fd-card");
        if (!card) return;
        state.dragging = true;
        e.dataTransfer.setData("text/plain", card.dataset.id);
        e.dataTransfer.effectAllowed = "move";
    });
    lanes.addEventListener("dragend", () => {
        state.dragging = false;
        lanes.querySelectorAll(".is-over").forEach((n) => n.classList.remove("is-over"));
    });
    lanes.addEventListener("dragover", (e) => {
        const lane = e.target.closest(".fd-lane");
        if (!lane) return;
        e.preventDefault();
        lanes.querySelectorAll(".is-over").forEach((n) => n !== lane && n.classList.remove("is-over"));
        lane.classList.add("is-over");
    });
    lanes.addEventListener("drop", (e) => {
        const lane = e.target.closest(".fd-lane");
        if (!lane) return;
        e.preventDefault();
        state.dragging = false;
        const id = Number(e.dataTransfer.getData("text/plain"));
        const stageId = Number(lane.dataset.stage);
        const alert = state.data.alerts.find((a) => a.id === id);
        if (alert && alert.stage_id !== stageId) moveStage(id, stageId);
        else lane.classList.remove("is-over");
    });

    $("#fd-drawer").addEventListener("click", (e) => {
        const btn = e.target.closest("[data-act]");
        if (!btn) return;
        if (btn.dataset.act === "close") { state.selected = null; renderDrawer(); }
        if (btn.dataset.act === "assign") act("/qc-deck/alert/assign", { alert_id: state.selected }, "Assigned to you");
        if (btn.dataset.act === "stage") moveStage(state.selected, Number(btn.dataset.stage));
    });
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && state.selected) { state.selected = null; renderDrawer(); }
    });

    // ------------------------------------------------------------ boot
    const tick = () => {
        $("#fd-clock").textContent = new Date().toLocaleTimeString([], { hour12: false });
    };
    tick();
    setInterval(tick, 1000);
    refresh();
    setInterval(() => { if (!document.hidden) refresh(); }, REFRESH_MS);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
})();
