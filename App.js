/**
 * SafeZone AI – Kamera-App (2. Handy) · Version 0.3 (WebRTC-Live + Linsenwahl).
 *
 * Sendet einen flüssigen, verzögerungsarmen LIVE-VIDEOSTREAM per WebRTC/WHIP an
 * MediaMTX (LXC 160). Vorteile ggü. Einzelfotos: kein Auslöser-Geräusch, kein
 * Blitzen, flüssiges Video, niedrige Latenz – und v.a.:
 *   -> Auswahl der PHYSISCHEN KAMERALINSE (Ultraweit/Haupt/Tele), soweit das
 *      Gerät die Linsen als eigene Kameras bereitstellt (mediaDevices.enumerateDevices,
 *      wie es andere Kamera-Apps über die Camera2-IDs auch machen).
 *   -> Auflösung bis 4K (2160p), sofern das Gerät/der Encoder das schafft.
 *
 * Serverseitig: MediaMTX nimmt den WHIP-Stream an -> Detektions-Worker liest RTSP
 * (detect_stream.py) -> YOLO -> Vorfall. Die Box-Koordinaten kommen per
 * ws://<host>:8090/boxes/<kamera> zurück (rotes Rechteck über der Vorschau).
 *
 * Modi: Automatik (startet selbst + verbindet neu) / Manuell (Knopf).
 * Zugriff nur über Tailscale-VPN.
 */
import React, { useEffect, useRef, useState, useCallback } from "react";
import {
  View, Text, TouchableOpacity, TextInput, StyleSheet, Modal, Platform,
  PermissionsAndroid, Switch, ScrollView,
} from "react-native";
import {
  RTCPeerConnection, RTCView, mediaDevices, RTCRtpReceiver, RTCRtpSender,
} from "react-native-webrtc";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { StatusBar } from "expo-status-bar";

// Standard-Einstellungen (im Einstellungs-Screen überschreibbar)
const DEFAULTS = {
  serverHost: "100.105.250.113", // Tailscale-IP des LXC 160
  webrtcPort: "8889",            // MediaMTX WHIP (WebRTC-Ingest)
  aiPort: "8090",                // KI-Dienst (Box-Overlay + Diagnose-Log)
  apiPort: "8080",               // Backend (Ort-Registrierung)
  cameraName: "CAM-01",          // = Stream-Pfad
  ort: "Haupteingang",           // Standort dieser Kamera (Bahnsteig/Eingang …)
  deviceId: "",                  // gewählte physische Linse (leer = Auto: erste Rückkamera)
  quality: "1080p",              // "720p" | "1080p" | "1440p" | "2160p"
  codec: "auto",                 // "auto" | "AV1" | "VP9" | "H264"
  autoStart: true,               // Automatik-Modus
};

// Kanonische Bahnhof-Orte (identisch zur Haupt-App). Der hier gewählte Ort wird
// beim Streamstart an das Backend gemeldet (/kamera/ort) und füllt vorfall.ort,
// damit CCTV/Patrol sehen, WO die Kamera steht bzw. das Bild entstand.
const ORTE = [
  "Haupteingang",
  "Bahnsteig 1 – Nord",
  "Bahnsteig 2 – Mitte",
  "Bahnsteig 3 – Aufzug",
  "Unterführung / Abschnitt 3",
  "Ausgang Ost / Vorplatz",
];

// Codec-Präferenzreihenfolge je Einstellung. "auto" nutzt H.264 (auf diesem
// Server garantiert erkennungs-/live-fähig, da die RTX 2060 SUPER kein
// Hardware-AV1 hat). AV1 ist bewusst MANUELL wählbar (spart Bandbreite, wird
// serverseitig per CPU-Software dekodiert). Alle Optionen behalten die volle
// Fallback-Kette -> abwärtskompatibel.
const CODEC_ORDER = {
  auto:  ["h264", "vp9", "av1"],
  AV1:   ["av1", "vp9", "h264"],
  VP9:   ["vp9", "h264", "av1"],
  H264:  ["h264", "vp9", "av1"],
};

// Qualitäts-Presets -> Aufnahme-Auflösung
const RES = {
  "720p":  { w: 1280, h: 720 },
  "1080p": { w: 1920, h: 1080 },
  "1440p": { w: 2560, h: 1440 },
  "2160p": { w: 3840, h: 2160 },   // 4K
};

// Ziel-Bitrate je Qualität (bit/s). WICHTIG gegen Verpixelung: WebRTC drosselt
// sonst auf ~1-2 Mbit und skaliert das Bild stark herunter. Wir setzen die
// Encoder-Bitrate explizit hoch + „maintain-resolution" (lieber Framerate opfern).
const BITRATE = {
  "720p":  3000000,
  "1080p": 6000000,
  "1440p": 10000000,
  "2160p": 16000000,   // 4K
};

export default function App() {
  const [cfg, setCfg] = useState(DEFAULTS);
  const [perm, setPerm] = useState(null);
  const [cams, setCams] = useState([]);         // verfügbare Linsen (videoinput)
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [status, setStatus] = useState("bereit");
  const [lastAlert, setLastAlert] = useState(null);
  const [det, setDet] = useState(null);
  const [viewSize, setViewSize] = useState({ w: 0, h: 0 });
  const [streamUrl, setStreamUrl] = useState(null);  // lokale Vorschau (RTCView)

  const pcRef = useRef(null);        // RTCPeerConnection
  const localStreamRef = useRef(null);
  const resourceRef = useRef(null);  // WHIP-Resource-URL (zum Beenden)
  const boxWsRef = useRef(null);
  const retryRef = useRef(null);
  const streamingRef = useRef(false);
  const cfgRef = useRef(cfg);
  cfgRef.current = cfg;
  const deviceId = useRef(`${Platform.OS}-${Math.random().toString(36).slice(2, 7)}`).current;

  // --- Remote-Logging (TEMPORÄR fürs Debugging, per SSH lesbar) --------------
  const rlog = useCallback((msg) => {
    try {
      const c = cfgRef.current;
      fetch(`http://${c.serverHost}:${c.aiPort}/clientlog`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device: `${deviceId}/${c.cameraName}`, msg: String(msg) }),
      }).catch(() => {});
    } catch (_) {}
  }, [deviceId]);

  // Standort dieser Kamera am Backend registrieren (füllt vorfall.ort)
  const registerOrt = useCallback((c) => {
    try {
      fetch(`http://${c.serverHost}:${c.apiPort}/kamera/ort`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: c.cameraName, ort: c.ort, bereich: c.ort }),
      }).then(() => rlog(`Ort registriert: ${c.cameraName} -> ${c.ort}`))
        .catch((e) => rlog("ort-register-fehler: " + String(e?.message || e)));
    } catch (_) {}
  }, [rlog]);

  // Einstellungen laden + Rechte anfragen + Linsen auflisten
  useEffect(() => {
    (async () => {
      const v = await AsyncStorage.getItem("cfg");
      const merged = v ? { ...DEFAULTS, ...JSON.parse(v) } : DEFAULTS;
      setCfg(merged); cfgRef.current = merged;
      const ok = await askPermissions();
      if (ok) await ladeLinsen(merged);
      registerOrt(merged);   // Standort dieser Kamera melden
      rlog(`=== App-Start (WebRTC/WHIP) === ${Platform.OS} ${Platform.Version}`);
    })();
    return () => stopEverything();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function askPermissions() {
    if (Platform.OS !== "android") { setPerm(true); return true; }
    try {
      const res = await PermissionsAndroid.requestMultiple([
        PermissionsAndroid.PERMISSIONS.CAMERA,
        PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
      ]);
      const ok = res[PermissionsAndroid.PERMISSIONS.CAMERA] === "granted"
              && res[PermissionsAndroid.PERMISSIONS.RECORD_AUDIO] === "granted";
      setPerm(ok);
      return ok;
    } catch (e) {
      rlog("perm-error: " + String(e?.message || e));
      setPerm(false);
      return false;
    }
  }

  // Verfügbare Kameralinsen des Geräts auflisten (wie andere Kamera-Apps:
  // jede vom System exponierte Camera2-ID = eine wählbare Linse).
  async function ladeLinsen(current) {
    try {
      const devs = await mediaDevices.enumerateDevices();
      const vids = (devs || []).filter((d) => d.kind === "videoinput");
      // Freundliche Bezeichnung je Linse ableiten (Front/Rück + laufende Nummer)
      let nBack = 0, nFront = 0;
      const list = vids.map((d) => {
        const front = String(d.facing || "").toLowerCase() === "front";
        const nr = front ? ++nFront : ++nBack;
        return {
          deviceId: d.deviceId,
          front,
          label: `${front ? "Frontkamera" : "Rückkamera"} ${nr}`,
          raw: d.label || "",
        };
      });
      setCams(list);
      // Vollständiger Geräte-Scan ins Server-Log (zur Analyse/Verbesserung der Linsenwahl)
      rlog("CAMERA-SCAN " + JSON.stringify(vids.map((d) => ({
        id: String(d.deviceId).slice(0, 24), facing: d.facing, label: d.label, kind: d.kind,
      }))));
      rlog(`Linsen: ${list.length} -> ${list.map((l) => l.label + "[" + l.raw + "]").join(", ")}`);
      // Falls noch keine Linse gewählt/ungültig: erste Rückkamera nehmen
      if (current && (!current.deviceId || !list.find((l) => l.deviceId === current.deviceId))) {
        const back = list.find((l) => !l.front) || list[0];
        if (back) { const next = { ...current, deviceId: back.deviceId }; setCfg(next); cfgRef.current = next; }
      }
    } catch (e) {
      rlog("enumerate-error: " + String(e?.message || e));
    }
  }

  async function saveCfg(next) {
    setCfg(next); cfgRef.current = next;
    await AsyncStorage.setItem("cfg", JSON.stringify(next));
  }

  // --- Box-Overlay: WS zum KI-Dienst -----------------------------------------
  function openBoxWs() {
    const c = cfgRef.current;
    const url = `ws://${c.serverHost}:${c.aiPort}/boxes/${c.cameraName}`;
    try {
      const ws = new WebSocket(url);
      boxWsRef.current = ws;
      ws.onopen = () => { rlog("box-ws open " + url); ws.send("hi"); };
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.alert && msg.box) {
            setDet({ box: msg.box, iw: msg.w, ih: msg.h, klasse: msg.klasse, konfidenz: msg.konfidenz });
            setLastAlert(`⚠ ${msg.klasse} (${(msg.konfidenz * 100).toFixed(0)}%)`);
          } else { setDet(null); }
        } catch (_) {}
      };
      ws.onclose = () => { boxWsRef.current = null; };
      ws.onerror = () => {};
    } catch (e) { rlog("box-ws error: " + String(e?.message || e)); }
  }
  function closeBoxWs() {
    if (boxWsRef.current) { try { boxWsRef.current.close(); } catch (_) {} boxWsRef.current = null; }
    setDet(null);
  }

  // Warten bis ICE-Kandidaten gesammelt sind (WHIP ohne Trickle)
  function warteIce(pc) {
    return new Promise((resolve) => {
      if (pc.iceGatheringState === "complete") return resolve();
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      pc.addEventListener("icegatheringstatechange", () => {
        if (pc.iceGatheringState === "complete") finish();
      });
      pc.addEventListener("icecandidate", (e) => { if (!e.candidate) finish(); });
      setTimeout(finish, 2500); // Fallback
    });
  }

  // --- Stream starten (WebRTC/WHIP) -----------------------------------------
  async function startStream() {
    const c = cfgRef.current;
    if (streamingRef.current) return;
    if (perm !== true) { const ok = await askPermissions(); if (!ok) return; await ladeLinsen(c); }
    registerOrt(c);   // Standort erneut melden (falls Kamera/Ort geändert)
    setStatus("Kamera öffnen …");
    try {
      const r = RES[c.quality] || RES["1080p"];
      // gewählte Linse + Auflösung
      const videoConstraints = {
        width: r.w, height: r.h, frameRate: 30,
        ...(c.deviceId ? { deviceId: c.deviceId } : { facingMode: "environment" }),
      };
      const stream = await mediaDevices.getUserMedia({ audio: true, video: videoConstraints });
      localStreamRef.current = stream;
      setStreamUrl(stream.toURL());

      const pc = new RTCPeerConnection({ iceServers: [] }); // im Tailnet keine STUN/TURN nötig
      pcRef.current = pc;
      stream.getTracks().forEach((t) => pc.addTrack(t, stream));

      // Codec-Präferenz (dynamisch): bevorzugten Codec nach vorne sortieren,
      // Rest als Fallback behalten -> der Server wählt beim Aushandeln den besten
      // gemeinsamen. AV1 erscheint nur, wenn das Handy es encodieren kann.
      try {
        const sndCaps = (RTCRtpSender.getCapabilities && RTCRtpSender.getCapabilities("video"))
          || (RTCRtpReceiver.getCapabilities && RTCRtpReceiver.getCapabilities("video"));
        const all = (sndCaps && sndCaps.codecs) ? sndCaps.codecs.slice() : [];
        if (all.length) {
          const pref = CODEC_ORDER[c.codec] || CODEC_ORDER.auto;
          const ordered = [];
          pref.forEach((k) => all.forEach((x) => {
            if (new RegExp(k, "i").test(x.mimeType) && !ordered.includes(x)) ordered.push(x);
          }));
          all.forEach((x) => { if (!ordered.includes(x)) ordered.push(x); }); // Rest (rtx/red…) als Fallback
          const verfuegbar = ["av1", "vp9", "h264"].filter((k) => all.some((x) => new RegExp(k, "i").test(x.mimeType)));
          rlog(`codec-wunsch=${c.codec} geraet-kann=${verfuegbar.join(",")}`);
          pc.getTransceivers().forEach((tx) => {
            if (tx.sender && tx.sender.track && tx.sender.track.kind === "video" && tx.setCodecPreferences) {
              try { tx.setCodecPreferences(ordered); } catch (e) { rlog("setCodecPref-fehler: " + (e?.message || e)); }
            }
          });
        }
      } catch (e) { rlog("codec-caps-fehler: " + String(e?.message || e)); }

      pc.addEventListener("connectionstatechange", () => {
        const st = pc.connectionState;
        rlog("pc state: " + st);
        if (st === "connected") {
          setStatus("LIVE – Stream läuft");
        } else if (st === "failed") {
          // Nur bei echtem Fehler neu aufbauen (nicht bei kurzem „disconnected",
          // aus dem sich WebRTC oft selbst erholt -> sonst ständiges Abreißen).
          streamingRef.current = false; setStreaming(false);
          setStatus("Verbindung fehlgeschlagen – neu …");
          teardownPc(); scheduleRetry();
        } else if (st === "disconnected") {
          setStatus("Verbindung instabil …");
        }
      });

      setStatus("verbinde (WHIP) …");
      const offer = await pc.createOffer({});
      await pc.setLocalDescription(offer);
      await warteIce(pc);

      const whip = `http://${c.serverHost}:${c.webrtcPort}/${c.cameraName}/whip`;
      rlog("WHIP POST -> " + whip + " (" + c.quality + ")");
      const resp = await fetch(whip, {
        method: "POST",
        headers: { "Content-Type": "application/sdp" },
        body: pc.localDescription.sdp,
      });
      if (!resp.ok) throw new Error("WHIP HTTP " + resp.status);
      resourceRef.current = resp.headers.get("Location") || resp.headers.get("location");
      const answer = await resp.text();
      await pc.setRemoteDescription({ type: "answer", sdp: answer });

      // Welchen Codec hat der Server tatsächlich ausgehandelt?
      try {
        const m = answer.match(/a=rtpmap:\d+\s+(AV1|VP9|VP8|H264)\/90000/i);
        const used = m ? m[1].toUpperCase() : "?";
        setStatus(`LIVE – ${used}`);
        rlog("ausgehandelter Codec: " + used);
      } catch (_) {}

      // Encoder-Bitrate explizit hochsetzen (gegen Verpixelung) + Auflösung halten
      try {
        const sender = pc.getSenders().find((s) => s.track && s.track.kind === "video");
        if (sender && sender.getParameters && sender.setParameters) {
          const p = sender.getParameters();
          if (!p.encodings || p.encodings.length === 0) p.encodings = [{}];
          p.encodings[0].maxBitrate = BITRATE[c.quality] || 6000000;
          p.encodings[0].maxFramerate = 30;
          p.degradationPreference = "maintain-resolution";
          await sender.setParameters(p);
          rlog("bitrate=" + (BITRATE[c.quality] || 6000000) + " q=" + c.quality);
        }
      } catch (e) { rlog("setParameters-fehler: " + String(e?.message || e)); }

      streamingRef.current = true;
      setStreaming(true);
      openBoxWs();
    } catch (e) {
      setStatus("Startfehler – Server/VPN prüfen");
      rlog("START-ERROR: " + String(e?.message || e));
      teardownPc();
      scheduleRetry();
    }
  }

  function teardownPc() {
    // WHIP-Resource am Server abmelden (falls vorhanden)
    if (resourceRef.current) {
      const c = cfgRef.current;
      const url = resourceRef.current.startsWith("http")
        ? resourceRef.current
        : `http://${c.serverHost}:${c.webrtcPort}${resourceRef.current}`;
      fetch(url, { method: "DELETE" }).catch(() => {});
      resourceRef.current = null;
    }
    if (pcRef.current) { try { pcRef.current.close(); } catch (_) {} pcRef.current = null; }
    if (localStreamRef.current) {
      try { localStreamRef.current.getTracks().forEach((t) => t.stop()); } catch (_) {}
      localStreamRef.current = null;
    }
    setStreamUrl(null);
  }

  function stopStream() {
    if (retryRef.current) { clearTimeout(retryRef.current); retryRef.current = null; }
    teardownPc();
    closeBoxWs();
    streamingRef.current = false;
    setStreaming(false);
    setStatus("gestoppt");
  }

  function stopEverything() {
    if (retryRef.current) { clearTimeout(retryRef.current); retryRef.current = null; }
    teardownPc();
    closeBoxWs();
  }

  function scheduleRetry() {
    if (!cfgRef.current.autoStart || retryRef.current) return;
    retryRef.current = setTimeout(() => {
      retryRef.current = null;
      if (cfgRef.current.autoStart && !streamingRef.current) startStream();
    }, 3000);
  }

  // Automatik: nach erteilter Berechtigung selbst starten
  useEffect(() => {
    if (perm === true && cfgRef.current.autoStart && !streamingRef.current) {
      const t = setTimeout(() => { if (!streamingRef.current) startStream(); }, 1200);
      return () => clearTimeout(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [perm]);

  // --- Berechtigungs-Gate ----------------------------------------------------
  if (perm === null) return <View style={styles.center}><Text style={styles.dim}>Lade …</Text></View>;
  if (perm === false) {
    return (
      <View style={styles.center}>
        <Text style={styles.title}>Kamera & Mikrofon benötigt</Text>
        <Text style={styles.dim}>Für den Live-Videostream werden Kamera- und Mikrofon-Zugriff gebraucht.</Text>
        <TouchableOpacity style={styles.btn} onPress={askPermissions}>
          <Text style={styles.btnText}>Zugriff erlauben</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // Box-Koordinaten (Serverbild-Pixel) auf Vorschau skalieren
  const boxStyle = (() => {
    if (!det || !viewSize.w || !det.iw) return null;
    const sx = viewSize.w / det.iw, sy = viewSize.h / det.ih;
    const [x1, y1, x2, y2] = det.box;
    return { left: x1 * sx, top: y1 * sy, width: (x2 - x1) * sx, height: (y2 - y1) * sy };
  })();

  const aktiveLinse = cams.find((l) => l.deviceId === cfg.deviceId);

  return (
    <View
      style={styles.container}
      onLayout={(e) => setViewSize({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}
    >
      <StatusBar style="light" />

      {/* Lokale Vorschau (WebRTC) */}
      {streamUrl ? (
        <RTCView streamURL={streamUrl} style={styles.camera} objectFit="cover" mirror={false} />
      ) : (
        <View style={[styles.camera, styles.center]}><Text style={styles.dim}>{status}</Text></View>
      )}

      {/* Rotes Rechteck über der erkannten Waffe */}
      {boxStyle && (
        <View pointerEvents="none" style={[styles.detBox, boxStyle]}>
          <Text style={styles.detLabel}>{det.klasse} {(det.konfidenz * 100).toFixed(0)}%</Text>
        </View>
      )}

      {/* Kopfzeile */}
      <View style={styles.header}>
        <Text style={styles.brand}>SafeZone · {cfg.cameraName}</Text>
        <TouchableOpacity onPress={() => setSettingsOpen(true)}>
          <Text style={styles.gear}>⚙︎</Text>
        </TouchableOpacity>
      </View>

      {/* Statuszeile */}
      <View style={styles.statusBar}>
        <View style={[styles.dot, { backgroundColor: streaming ? "#22c55e" : "#6b7280" }]} />
        <Text style={styles.statusText}>
          {status}{cfg.autoStart ? " · Automatik" : ""}{aktiveLinse ? " · " + aktiveLinse.label : ""} · {cfg.quality}
        </Text>
        {lastAlert ? <Text style={styles.alert}>{lastAlert}</Text> : null}
      </View>

      {/* Start/Stop */}
      <View style={styles.footer}>
        <TouchableOpacity
          style={[styles.bigBtn, { backgroundColor: streaming ? "#dc2626" : "#f97316" }]}
          onPress={streaming ? stopStream : startStream}
        >
          <Text style={styles.bigBtnText}>{streaming ? "STREAM STOPPEN" : "STREAM STARTEN"}</Text>
        </TouchableOpacity>
      </View>

      {/* Einstellungen */}
      <SettingsModal
        open={settingsOpen}
        cfg={cfg}
        cams={cams}
        streaming={streaming}
        onRefreshLenses={() => ladeLinsen(cfgRef.current)}
        onClose={() => setSettingsOpen(false)}
        onSave={(next) => {
          const wasStreaming = streamingRef.current;
          saveCfg(next);
          registerOrt(next);   // geänderten Standort sofort melden
          setSettingsOpen(false);
          if (wasStreaming) { stopStream(); setTimeout(() => startStream(), 700); }
        }}
      />
    </View>
  );
}

function SettingsModal({ open, cfg, cams, streaming, onRefreshLenses, onClose, onSave }) {
  const [draft, setDraft] = useState(cfg);
  useEffect(() => setDraft(cfg), [cfg, open]);

  const field = (label, key, keyboard = "default") => (
    <View style={{ marginBottom: 12 }}>
      <Text style={styles.label}>{label}</Text>
      <TextInput style={styles.input} value={String(draft[key])} keyboardType={keyboard}
        autoCapitalize="none" onChangeText={(t) => setDraft({ ...draft, [key]: t })} />
    </View>
  );

  const chooser = (label, key, options) => (
    <View style={{ marginBottom: 12 }}>
      <Text style={styles.label}>{label}</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {options.map((o) => (
          <TouchableOpacity key={o.value}
            onPress={() => setDraft({ ...draft, [key]: o.value })}
            style={[styles.choice, draft[key] === o.value && styles.choiceActive]}>
            <Text style={[styles.choiceTxt, draft[key] === o.value && styles.choiceTxtActive]}>{o.label}</Text>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );

  return (
    <Modal visible={open} animationType="slide" transparent>
      <View style={styles.modalBg}>
        <View style={styles.modalCard}>
          <ScrollView>
            <Text style={styles.title}>Einstellungen</Text>

            {/* Standort dieser Kamera (füllt vorfall.ort in der Haupt-App) */}
            <View style={{ marginBottom: 12 }}>
              <Text style={styles.label}>Standort dieser Kamera</Text>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                {ORTE.map((o) => (
                  <TouchableOpacity key={o}
                    onPress={() => setDraft({ ...draft, ort: o })}
                    style={[styles.choice, draft.ort === o && styles.choiceActive]}>
                    <Text style={[styles.choiceTxt, draft.ort === o && styles.choiceTxtActive]}>{o}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              <Text style={styles.hint}>Wird beim Start an den Server gemeldet – CCTV/Patrol sehen dann diesen Ort am Vorfall.</Text>
            </View>

            {/* Linsen-Auswahl (physische Kameras des Geräts) */}
            <View style={{ marginBottom: 12 }}>
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                <Text style={styles.label}>Kamera-Linse</Text>
                <TouchableOpacity onPress={onRefreshLenses}><Text style={styles.link}>↻ neu suchen</Text></TouchableOpacity>
              </View>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                {cams.length === 0 ? <Text style={styles.hint}>Keine Linsen gefunden – „neu suchen".</Text> : null}
                {cams.map((l) => (
                  <TouchableOpacity key={l.deviceId}
                    onPress={() => setDraft({ ...draft, deviceId: l.deviceId })}
                    style={[styles.choice, draft.deviceId === l.deviceId && styles.choiceActive]}>
                    <Text style={[styles.choiceTxt, draft.deviceId === l.deviceId && styles.choiceTxtActive]}>{l.label}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              <Text style={styles.hint}>Mehrere Rückkameras = Ultraweit/Haupt/Tele (je nach Gerät). Einfach durchprobieren.</Text>
            </View>

            {chooser("Qualität", "quality", [
              { value: "720p", label: "720p" },
              { value: "1080p", label: "1080p" },
              { value: "1440p", label: "2K" },
              { value: "2160p", label: "4K" },
            ])}

            {chooser("Codec", "codec", [
              { value: "auto", label: "Auto" },
              { value: "AV1", label: "AV1" },
              { value: "VP9", label: "VP9" },
              { value: "H264", label: "H.264" },
            ])}
            <Text style={styles.hint}>Empfehlung: Auto/H.264 – auf diesem Server garantiert erkennungs- & live-fähig. AV1 spart Bandbreite, wird aber nur per CPU-Software dekodiert (RTX 2060 SUPER hat kein Hardware-AV1) – nur manuell wählen und prüfen, ob die Erkennung anspringt.</Text>

            <View style={styles.rowBetween}>
              <View style={{ flex: 1 }}>
                <Text style={styles.label}>Automatik-Modus</Text>
                <Text style={styles.hint}>Startet selbst & verbindet bei Abbruch neu</Text>
              </View>
              <Switch value={!!draft.autoStart}
                onValueChange={(v) => setDraft({ ...draft, autoStart: v })}
                trackColor={{ true: "#f97316", false: "#374151" }} thumbColor="#fff" />
            </View>

            {field("Server-Host (Tailscale-IP)", "serverHost")}
            {field("Kamera-Name (Stream-Pfad)", "cameraName")}
            {field("WebRTC-Port (WHIP)", "webrtcPort", "numeric")}
            {field("KI-Port (Overlay/Log)", "aiPort", "numeric")}
            {field("Backend-Port (Ort)", "apiPort", "numeric")}

            {streaming ? <Text style={styles.hint}>Änderungen setzen den laufenden Stream neu auf.</Text> : null}

            <View style={{ flexDirection: "row", gap: 10, marginTop: 8, marginBottom: 8 }}>
              <TouchableOpacity style={[styles.btn, { flex: 1, backgroundColor: "#374151" }]} onPress={onClose}>
                <Text style={styles.btnText}>Abbrechen</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.btn, { flex: 1 }]} onPress={() => onSave(draft)}>
                <Text style={styles.btnText}>Speichern</Text>
              </TouchableOpacity>
            </View>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#050508" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "#050508", padding: 24 },
  camera: { ...StyleSheet.absoluteFillObject },
  header: {
    position: "absolute", top: 50, left: 16, right: 16, flexDirection: "row",
    justifyContent: "space-between", alignItems: "center",
  },
  brand: { color: "#fff", fontWeight: "700", fontSize: 15, textShadowColor: "#000", textShadowRadius: 6 },
  gear: { color: "#fff", fontSize: 26 },
  statusBar: {
    position: "absolute", top: 88, left: 16, right: 16, flexDirection: "row",
    alignItems: "center", gap: 8, backgroundColor: "#00000080", padding: 8, borderRadius: 10,
  },
  dot: { width: 10, height: 10, borderRadius: 5 },
  statusText: { color: "#e5e7eb", fontSize: 12, flexShrink: 1 },
  alert: { color: "#f97316", fontWeight: "700", marginLeft: "auto" },
  detBox: { position: "absolute", borderWidth: 3, borderColor: "#ff2d2d", borderRadius: 4, backgroundColor: "#ff00001a" },
  detLabel: { position: "absolute", top: -20, left: 0, backgroundColor: "#ff2d2d", color: "#fff", fontSize: 11, fontWeight: "800", paddingHorizontal: 4, paddingVertical: 1, borderRadius: 3 },
  footer: { position: "absolute", bottom: 40, left: 24, right: 24 },
  bigBtn: { paddingVertical: 18, borderRadius: 16, alignItems: "center" },
  bigBtnText: { color: "#fff", fontWeight: "800", fontSize: 16, letterSpacing: 1 },
  title: { color: "#fff", fontSize: 20, fontWeight: "700", marginBottom: 16 },
  dim: { color: "#9ca3af", textAlign: "center" },
  btn: { backgroundColor: "#f97316", paddingVertical: 12, paddingHorizontal: 16, borderRadius: 12, alignItems: "center" },
  btnText: { color: "#fff", fontWeight: "700" },
  label: { color: "#9ca3af", fontSize: 12, marginBottom: 6 },
  link: { color: "#f97316", fontSize: 12, fontWeight: "700" },
  hint: { color: "#64708a", fontSize: 11, marginTop: 6 },
  input: { backgroundColor: "#111118", color: "#fff", borderRadius: 10, padding: 12, borderWidth: 1, borderColor: "#26263a" },
  rowBetween: { flexDirection: "row", alignItems: "center", marginBottom: 12 },
  choice: { paddingVertical: 10, paddingHorizontal: 14, borderRadius: 10, borderWidth: 1, borderColor: "#26263a", alignItems: "center", backgroundColor: "#111118" },
  choiceActive: { borderColor: "#f97316", backgroundColor: "#1e110a" },
  choiceTxt: { color: "#9ca3af", fontWeight: "700", fontSize: 13 },
  choiceTxtActive: { color: "#f97316" },
  modalBg: { flex: 1, backgroundColor: "#000000aa", justifyContent: "center", padding: 20 },
  modalCard: { backgroundColor: "#0b0b13", borderRadius: 18, padding: 20, borderWidth: 1, borderColor: "#26263a", maxHeight: "85%" },
});
