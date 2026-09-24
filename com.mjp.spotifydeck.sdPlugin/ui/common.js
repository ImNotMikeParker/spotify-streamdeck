/* Shared property-inspector logic: the Spotify account section + helpers. Loaded by every action's UI. */
(function () {
  const client = () => window.SDPIComponents && window.SDPIComponents.streamDeckClient;

  function el(tag, attrs, children) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === "text") n.textContent = v;
      else if (k === "html") n.innerHTML = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    }
    for (const c of children || []) n.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    return n;
  }

  const state = { status: null };

  function renderAccount() {
    const host = document.getElementById("account");
    if (!host) return;
    host.innerHTML = "";
    const s = state.status;
    const connected = !!(s && s.connected);

    const statusLine = el("div", { class: "sd-status " + (connected ? "ok" : s && s.busy ? "busy" : "warn") }, [
      el("span", { class: "dot" }),
      el("span", {
        text: !s
          ? "Checking Spotify connection…"
          : connected
            ? "Connected" + (s.userName ? " as " + s.userName : "")
            : s.busy
              ? "Waiting for the browser…"
              : "Not connected",
      }),
    ]);
    host.appendChild(el("sdpi-item", { label: "Spotify" }, [statusLine]));

    if (s && s.message && !(connected && /^Connected/.test(s.message))) {
      host.appendChild(el("sdpi-item", { label: "" }, [el("div", { class: "sd-note", text: s.message })]));
    }

    const details = el("details", { class: "sd-setup" });
    if (!connected) details.setAttribute("open", "");
    details.appendChild(el("summary", { text: connected ? "Account settings" : "Set up (one time, about 2 minutes)" }));

    const redirect = (s && s.redirectUri) || "http://127.0.0.1:8888/callback";
    details.appendChild(
      el("ol", { class: "sd-steps" }, [
        el("li", { html: 'Open the <a href="#" data-url="https://developer.spotify.com/dashboard">Spotify Developer Dashboard</a> and click <b>Create app</b>.' }),
        el("li", { html: "Give it any name. Under <b>Redirect URIs</b> add exactly:" }),
        el("div", { class: "sd-code-row" }, [
          el("code", { id: "redirect-uri", text: redirect }),
          el("button", { class: "sd-mini", text: "Copy", onclick: () => navigator.clipboard && navigator.clipboard.writeText(redirect) }),
        ]),
        el("li", { html: "Tick <b>Web API</b>, save, then copy the app's <b>Client ID</b> below and press Connect." }),
      ]),
    );

    const clientId = el("input", { type: "text", id: "client-id", placeholder: "Client ID (32 characters)", value: (s && s.clientId) || "", spellcheck: "false" });
    const port = el("input", { type: "number", id: "port", min: "1024", max: "65535", value: String((s && s.port) || 8888), title: "Local port for the sign-in callback" });
    port.addEventListener("input", () => {
      const p = Number(port.value) || 8888;
      const code = document.getElementById("redirect-uri");
      if (code) code.textContent = "http://127.0.0.1:" + p + "/callback";
    });

    details.appendChild(el("sdpi-item", { label: "Client ID" }, [clientId]));
    details.appendChild(el("sdpi-item", { label: "Port" }, [port]));

    const buttons = el("div", { class: "sd-buttons" });
    const connectBtn = el("button", {
      class: "sd-primary",
      text: connected ? "Reconnect" : "Connect to Spotify",
      onclick: () => {
        const id = clientId.value.trim();
        if (!id) {
          clientId.focus();
          return;
        }
        state.status = Object.assign({}, state.status, { busy: true, message: "Opening your browser…" });
        renderAccount();
        send({ event: "connect", clientId: id, port: Number(port.value) || undefined });
      },
    });
    if (s && s.busy) connectBtn.setAttribute("disabled", "");
    buttons.appendChild(connectBtn);
    if (connected) buttons.appendChild(el("button", { text: "Disconnect", onclick: () => send({ event: "disconnect" }) }));
    details.appendChild(el("sdpi-item", { label: "" }, [buttons]));
    host.appendChild(details);
    if (connected && s.stats) {
      const st = s.stats;
      const mode =
        st.mode === "limited"
          ? "Paused by Spotify until " + new Date(st.limitedUntil).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
          : st.mode === "local"
            ? "watching the Spotify window (few API calls)"
            : st.mode === "dormant"
              ? "idle, checking rarely"
              : "polling Spotify (playback is on another device" + (st.watcher ? "" : ", or window watcher unavailable") + ")";
      host.appendChild(el("div", { class: "sd-attrib", text: "API calls today: " + st.callsToday + " · " + mode }));
    }
    host.appendChild(el("div", { class: "sd-attrib", text: "Track info and artwork provided by Spotify." }));

    host.querySelectorAll("a[data-url]").forEach((a) =>
      a.addEventListener("click", (e) => {
        e.preventDefault();
        openUrl(a.getAttribute("data-url"));
      }),
    );
  }

  function send(payload) {
    const c = client();
    if (c) c.send("sendToPlugin", payload);
  }

  function openUrl(url) {
    const c = client();
    if (c) c.send("openUrl", { url });
  }

  function onMessage(msg) {
    const payload = msg && msg.payload && msg.payload.event ? msg.payload : msg;
    if (!payload || !payload.event) return;
    if (payload.event === "auth-status") {
      state.status = payload;
      renderAccount();
    }
    document.dispatchEvent(new CustomEvent("plugin-message", { detail: payload }));
  }

  function init() {
    const c = client();
    if (!c) {
      setTimeout(init, 50);
      return;
    }
    c.sendToPropertyInspector.subscribe(onMessage);
    renderAccount();
    send({ event: "get-auth-status" });
  }

  window.SpotifyPI = { send, openUrl, onMessage: (fn) => document.addEventListener("plugin-message", (e) => fn(e.detail)) };
  document.addEventListener("DOMContentLoaded", init);
})();
