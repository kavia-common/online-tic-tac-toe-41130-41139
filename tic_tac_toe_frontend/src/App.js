import React, { useEffect, useMemo, useRef, useState } from "react";
import "./App.css";

/**
 * All possible winning line triplets (indices into the 9-cell board).
 * Kept as a constant for clarity and easy reuse.
 */
const WINNING_LINES = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],

  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],

  [0, 4, 8],
  [2, 4, 6],
];

/**
 * Derive winner and the winning line (if any).
 * Returns { winner: "X" | "O" | null, line: number[] | null }.
 */
function calculateWinner(board) {
  for (const [a, b, c] of WINNING_LINES) {
    const v = board[a];
    if (v && v === board[b] && v === board[c]) {
      return { winner: v, line: [a, b, c] };
    }
  }
  return { winner: null, line: null };
}

/**
 * Generate a short, human-shareable session code.
 * Not cryptographically secure; meant only as an easy pairing identifier.
 */
function generateSessionCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 6; i += 1)
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

/**
 * Build a shareable join link with a session param.
 */
function buildJoinLink(sessionId) {
  const url = new URL(window.location.href);
  url.searchParams.set("session", sessionId);
  return url.toString();
}

/**
 * Get an existing session code from the current URL (if present).
 */
function getSessionFromUrl() {
  try {
    const url = new URL(window.location.href);
    return url.searchParams.get("session");
  } catch {
    return null;
  }
}

/**
 * Minimal WebSocket signaling client for exchanging WebRTC offer/answer/candidate messages.
 * This intentionally assumes a lightweight signaling server protocol:
 *   - client sends: { type: "join", sessionId }
 *   - server may broadcast between peers within the session:
 *       { type: "peer-joined" }
 *       { type: "signal", sessionId, payload: { type: "offer"|"answer"|"candidate", sdp?, candidate? } }
 *
 * If the server uses a different schema, only this adapter needs adjustment.
 */
class SignalingClient {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.sessionId = null;
    this.isConnected = false;

    this.onStatus = null; // (status: { state, message }) => void
    this.onPeerJoined = null; // () => void
    this.onSignal = null; // (payload) => void
  }

  // PUBLIC_INTERFACE
  connect() {
    /** Connect to the WebSocket signaling server. Returns a Promise that resolves when open. */
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.url);
      } catch (err) {
        reject(err);
        return;
      }

      const handleOpen = () => {
        this.isConnected = true;
        this._emitStatus({
          state: "connected",
          message: "Signaling connected",
        });
        resolve();
      };

      const handleError = () => {
        this._emitStatus({
          state: "error",
          message: "Signaling connection error",
        });
        reject(new Error("WebSocket connection error"));
      };

      this.ws.addEventListener("open", handleOpen, { once: true });
      this.ws.addEventListener("error", handleError, { once: true });

      this.ws.addEventListener("close", () => {
        this.isConnected = false;
        this._emitStatus({
          state: "disconnected",
          message: "Signaling disconnected",
        });
      });

      this.ws.addEventListener("message", (ev) => {
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }

        if (!msg || typeof msg !== "object") return;

        if (msg.type === "peer-joined") {
          if (this.onPeerJoined) this.onPeerJoined();
          return;
        }

        if (msg.type === "signal" && msg.payload) {
          if (this.onSignal) this.onSignal(msg.payload);
        }
      });

      this._emitStatus({
        state: "connecting",
        message: "Connecting to signaling...",
      });
    });
  }

  // PUBLIC_INTERFACE
  join(sessionId) {
    /** Join a signaling session/room. */
    this.sessionId = sessionId;
    this._send({ type: "join", sessionId });
  }

  // PUBLIC_INTERFACE
  sendSignal(payload) {
    /** Send a WebRTC signaling message to other peers in the session. */
    if (!this.sessionId) return;
    this._send({ type: "signal", sessionId: this.sessionId, payload });
  }

  // PUBLIC_INTERFACE
  close() {
    /** Close the signaling connection. */
    try {
      if (this.ws) this.ws.close();
    } catch {
      // ignore
    } finally {
      this.ws = null;
      this.isConnected = false;
    }
  }

  _send(obj) {
    try {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify(obj));
      }
    } catch {
      // ignore send errors; the caller will see disconnect via close/error
    }
  }

  _emitStatus(status) {
    if (this.onStatus) this.onStatus(status);
  }
}

/**
 * A thin WebRTC manager that creates/accepts a DataChannel and forwards game messages.
 * Uses SignalingClient for exchanging offer/answer/candidates.
 */
class WebRtcPeer {
  constructor({ isInitiator, signalingClient, onDataMessage, onState }) {
    this.isInitiator = isInitiator;
    this.signaling = signalingClient;

    this.onDataMessage = onDataMessage; // (msgObj) => void
    this.onState = onState; // (s) => void

    this.pc = null;
    this.dc = null;
    this._pendingCandidates = [];

    // A conservative public STUN server helps with NAT traversal in many cases.
    // If your environment forbids it, you can set ICE to empty or supply your own.
    this.rtcConfig = {
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    };
  }

  // PUBLIC_INTERFACE
  async start() {
    /** Start WebRTC flow. If initiator, creates offer immediately. */
    this._ensurePeerConnection();

    if (this.isInitiator) {
      this._createDataChannel();
      await this._makeOffer();
    }
  }

  // PUBLIC_INTERFACE
  async handleSignal(payload) {
    /** Handle incoming signaling messages. */
    if (!payload || typeof payload !== "object") return;

    this._ensurePeerConnection();

    if (payload.type === "offer" && payload.sdp) {
      await this.pc.setRemoteDescription({ type: "offer", sdp: payload.sdp });
      await this._flushPendingCandidates();
      await this._makeAnswer();
      return;
    }

    if (payload.type === "answer" && payload.sdp) {
      await this.pc.setRemoteDescription({ type: "answer", sdp: payload.sdp });
      await this._flushPendingCandidates();
      return;
    }

    if (payload.type === "candidate" && payload.candidate) {
      const cand = payload.candidate;
      if (this.pc.remoteDescription) {
        try {
          await this.pc.addIceCandidate(cand);
        } catch {
          // ignore
        }
      } else {
        this._pendingCandidates.push(cand);
      }
    }
  }

  // PUBLIC_INTERFACE
  sendData(obj) {
    /** Send a JSON message over the data channel. No-op if not connected. */
    if (!this.dc || this.dc.readyState !== "open") return;
    try {
      this.dc.send(JSON.stringify(obj));
    } catch {
      // ignore
    }
  }

  // PUBLIC_INTERFACE
  close() {
    /** Close data channel and RTCPeerConnection. */
    try {
      if (this.dc) this.dc.close();
    } catch {
      // ignore
    }
    try {
      if (this.pc) this.pc.close();
    } catch {
      // ignore
    }
    this.dc = null;
    this.pc = null;
    this._pendingCandidates = [];
    this._emitState({ state: "closed", message: "P2P closed" });
  }

  _ensurePeerConnection() {
    if (this.pc) return;

    this.pc = new RTCPeerConnection(this.rtcConfig);

    this.pc.addEventListener("icecandidate", (ev) => {
      if (ev.candidate) {
        this.signaling.sendSignal({
          type: "candidate",
          candidate: ev.candidate,
        });
      }
    });

    this.pc.addEventListener("connectionstatechange", () => {
      this._emitState({
        state: this.pc.connectionState,
        message: `P2P connection: ${this.pc.connectionState}`,
      });
    });

    this.pc.addEventListener("datachannel", (ev) => {
      // Answerer receives the initiator-created DataChannel here.
      this.dc = ev.channel;
      this._wireDataChannel();
    });
  }

  _createDataChannel() {
    if (!this.pc) return;
    if (this.dc) return;
    this.dc = this.pc.createDataChannel("tictactoe");
    this._wireDataChannel();
  }

  _wireDataChannel() {
    if (!this.dc) return;

    this.dc.addEventListener("open", () => {
      this._emitState({ state: "open", message: "P2P data channel open" });
    });

    this.dc.addEventListener("close", () => {
      this._emitState({ state: "closed", message: "P2P data channel closed" });
    });

    this.dc.addEventListener("message", (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (this.onDataMessage) this.onDataMessage(msg);
    });
  }

  async _makeOffer() {
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    this.signaling.sendSignal({ type: "offer", sdp: offer.sdp });
    this._emitState({ state: "offered", message: "Offer sent" });
  }

  async _makeAnswer() {
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    this.signaling.sendSignal({ type: "answer", sdp: answer.sdp });
    this._emitState({ state: "answered", message: "Answer sent" });
  }

  async _flushPendingCandidates() {
    const pending = this._pendingCandidates.slice();
    this._pendingCandidates = [];
    for (const cand of pending) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await this.pc.addIceCandidate(cand);
      } catch {
        // ignore
      }
    }
  }

  _emitState(s) {
    if (this.onState) this.onState(s);
  }
}

// PUBLIC_INTERFACE
function App() {
  /** App entrypoint that renders the full game experience. */
  return <Game />;
}

/**
 * Top-level game component: owns the game state.
 * If REACT_APP_WS_URL is configured and reachable, enables optional P2P mode.
 */
function Game() {
  const wsUrl = (process.env.REACT_APP_WS_URL || "").trim();
  const onlineAvailable = Boolean(wsUrl);

  const [board, setBoard] = useState(() => Array(9).fill(null));
  const [xIsNext, setXIsNext] = useState(true);

  // Online/P2P UI state (only shown if env var is present)
  const [sessionInput, setSessionInput] = useState("");
  const [sessionId, setSessionId] = useState(() => getSessionFromUrl() || "");
  const [mode, setMode] = useState("local"); // "local" | "online"
  const [onlineRole, setOnlineRole] = useState(null); // "host" | "guest" | null

  const [netStatus, setNetStatus] = useState({
    state: onlineAvailable ? "idle" : "unavailable",
    message: onlineAvailable
      ? "Online mode available"
      : "Online mode not configured",
  });

  // Refs for network objects (avoid re-instantiation across renders)
  const signalingRef = useRef(null);
  const rtcRef = useRef(null);

  // Prevent feedback loops when applying remote state
  const applyingRemoteRef = useRef(false);

  const { winner, line: winningLine } = useMemo(
    () => calculateWinner(board),
    [board],
  );
  const isDraw = useMemo(
    () => !winner && board.every((c) => c !== null),
    [winner, board],
  );

  const statusText = useMemo(() => {
    // Minimal status rules: winner > draw > current player
    if (winner) return `Winner: ${winner}`;
    if (isDraw) return "Draw";
    return `Current player: ${xIsNext ? "X" : "O"}`;
  }, [winner, isDraw, xIsNext]);

  const isOnline = mode === "online";

  // If URL contains ?session=... and online is available, show a subtle hint.
  useEffect(() => {
    if (!onlineAvailable) return;
    const urlSession = getSessionFromUrl();
    if (urlSession) {
      setSessionId(urlSession);
      setSessionInput(urlSession);
      setNetStatus((s) => ({
        ...s,
        state: "idle",
        message: "Session code detected from link. Join to connect.",
      }));
    }
  }, [onlineAvailable]);

  const localApplyMove = (index) => {
    if (board[index] !== null || winner || isDraw) return false;

    setBoard((prev) => {
      const next = prev.slice();
      next[index] = xIsNext ? "X" : "O";
      return next;
    });
    setXIsNext((prev) => !prev);
    return true;
  };

  // PUBLIC_INTERFACE
  const handleSquareClick = (index) => {
    /**
     * Handle local click. In online mode, we enforce "your turn" and broadcast state
     * over the data channel to keep both peers consistent.
     */
    if (winner || isDraw) return;

    if (isOnline) {
      // Host plays X, guest plays O.
      const myMark =
        onlineRole === "host" ? "X" : onlineRole === "guest" ? "O" : null;
      if (!myMark) return;

      const expectedMark = xIsNext ? "X" : "O";
      if (myMark !== expectedMark) return;

      if (board[index] !== null) return;

      // Apply move locally, then broadcast full state snapshot.
      const moved = localApplyMove(index);
      if (moved) {
        // Compute the next state snapshot using the "post-click" known mutation.
        const nextBoard = board.slice();
        nextBoard[index] = myMark;
        const nextXIsNext = !xIsNext;

        rtcRef.current?.sendData({
          type: "state",
          board: nextBoard,
          xIsNext: nextXIsNext,
        });
      }
      return;
    }

    // Local hotseat mode
    localApplyMove(index);
  };

  // PUBLIC_INTERFACE
  const handleRestart = () => {
    /** Reset game state and broadcast in online mode. */
    setBoard(Array(9).fill(null));
    setXIsNext(true);

    if (isOnline) {
      rtcRef.current?.sendData({
        type: "state",
        board: Array(9).fill(null),
        xIsNext: true,
      });
    }
  };

  const cleanupOnline = () => {
    rtcRef.current?.close?.();
    rtcRef.current = null;
    signalingRef.current?.close?.();
    signalingRef.current = null;
  };

  useEffect(() => {
    // Cleanup on unmount
    return () => cleanupOnline();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const applyRemoteState = (remote) => {
    if (!remote || !Array.isArray(remote.board) || remote.board.length !== 9)
      return;

    applyingRemoteRef.current = true;
    setBoard(remote.board.slice());
    setXIsNext(Boolean(remote.xIsNext));
    // Release guard in next tick to avoid racing local broadcasts
    setTimeout(() => {
      applyingRemoteRef.current = false;
    }, 0);
  };

  const startOnline = async ({ role, session }) => {
    if (!onlineAvailable) return;

    setMode("online");
    setOnlineRole(role);
    setSessionId(session);

    cleanupOnline();
    setNetStatus({ state: "connecting", message: "Connecting..." });

    const signaling = new SignalingClient(wsUrl);
    signalingRef.current = signaling;

    signaling.onStatus = (s) => setNetStatus(s);

    signaling.onSignal = async (payload) => {
      try {
        await rtcRef.current?.handleSignal?.(payload);
      } catch {
        // If signaling messages fail, fall back to local gracefully.
        setNetStatus({
          state: "error",
          message: "P2P negotiation failed. Falling back to local.",
        });
        cleanupOnline();
        setMode("local");
        setOnlineRole(null);
      }
    };

    signaling.onPeerJoined = async () => {
      // Host starts negotiation only after another peer is present.
      if (role !== "host") return;
      try {
        await rtcRef.current?.start?.();
      } catch {
        setNetStatus({
          state: "error",
          message: "Could not start P2P. Falling back to local.",
        });
        cleanupOnline();
        setMode("local");
        setOnlineRole(null);
      }
    };

    try {
      await signaling.connect();
    } catch {
      setNetStatus({
        state: "error",
        message: "Signaling unreachable. Falling back to local.",
      });
      cleanupOnline();
      setMode("local");
      setOnlineRole(null);
      return;
    }

    const rtc = new WebRtcPeer({
      isInitiator: role === "host",
      signalingClient: signaling,
      onState: (s) => setNetStatus((prev) => ({ ...prev, ...s })),
      onDataMessage: (msg) => {
        if (!msg || typeof msg !== "object") return;

        if (msg.type === "state") {
          applyRemoteState(msg);
          return;
        }

        if (msg.type === "request-state") {
          // When the guest connects, host sends a full snapshot.
          rtc.sendData({ type: "state", board, xIsNext });
        }
      },
    });
    rtcRef.current = rtc;

    // Join the session after websocket connect.
    signaling.join(session);

    // Answerer starts PC right away (waits for offer)
    if (role === "guest") {
      await rtc.start();
    }

    // Once connected, the guest can request state.
    // We do it after a small delay; if the channel isn't open yet, it no-ops.
    setTimeout(() => {
      rtcRef.current?.sendData({ type: "request-state" });
    }, 600);
  };

  // PUBLIC_INTERFACE
  const handleCreateSession = async () => {
    /** Create a new session and become host (X). */
    const code = generateSessionCode();
    setSessionInput(code);
    await startOnline({ role: "host", session: code });
  };

  // PUBLIC_INTERFACE
  const handleJoinSession = async () => {
    /** Join an existing session and become guest (O). */
    const code = (sessionInput || "").trim().toUpperCase();
    if (!code) return;
    await startOnline({ role: "guest", session: code });
  };

  // PUBLIC_INTERFACE
  const handleLeaveOnline = () => {
    /** Leave online mode and return to local hotseat. */
    cleanupOnline();
    setMode("local");
    setOnlineRole(null);
    setNetStatus({
      state: onlineAvailable ? "idle" : "unavailable",
      message: onlineAvailable
        ? "Online mode available"
        : "Online mode not configured",
    });
  };

  const joinLink = useMemo(() => {
    if (!sessionId) return "";
    return buildJoinLink(sessionId);
  }, [sessionId]);

  const modeLabel = useMemo(() => {
    if (!onlineAvailable) return "Local (hotseat)";
    if (!isOnline) return "Local (hotseat)";
    return `Online (P2P) • You are ${onlineRole === "host" ? "X (host)" : "O (guest)"}`;
  }, [onlineAvailable, isOnline, onlineRole]);

  return (
    <main className="app">
      <section className="gameCard" aria-label="Tic Tac Toe">
        <header className="statusHeader">
          <div className="statusTitle">Tic Tac Toe</div>

          <div className="metaRow">
            <div className="metaPill" aria-label="Game mode">
              {modeLabel}
            </div>
            {onlineAvailable ? (
              <div
                className={`metaPill ${netStatus.state === "error" ? "isError" : ""}`}
              >
                {netStatus.message}
              </div>
            ) : null}
          </div>

          {onlineAvailable ? (
            <div className="onlinePanel" aria-label="Online session controls">
              <div className="onlineRow">
                <label className="field">
                  <span className="fieldLabel">Session code</span>
                  <input
                    className="textInput"
                    value={sessionInput}
                    onChange={(e) =>
                      setSessionInput(e.target.value.toUpperCase())
                    }
                    placeholder="E.g. Q7K2ZP"
                    inputMode="text"
                    autoCapitalize="characters"
                    disabled={isOnline}
                    aria-label="Session code"
                  />
                </label>

                <div className="onlineButtons">
                  {!isOnline ? (
                    <>
                      <button
                        className="btnSecondary"
                        type="button"
                        onClick={handleCreateSession}
                      >
                        Create
                      </button>
                      <button
                        className="btnPrimarySmall"
                        type="button"
                        onClick={handleJoinSession}
                      >
                        Join
                      </button>
                    </>
                  ) : (
                    <button
                      className="btnGhost"
                      type="button"
                      onClick={handleLeaveOnline}
                    >
                      Leave online
                    </button>
                  )}
                </div>
              </div>

              {isOnline && sessionId ? (
                <div className="shareRow">
                  <div className="shareLabel">Share link:</div>
                  <a className="shareLink" href={joinLink}>
                    {joinLink}
                  </a>
                </div>
              ) : null}
            </div>
          ) : null}

          <div
            className={`statusPill ${winner ? "isWinner" : ""} ${isDraw ? "isDraw" : ""}`}
            role="status"
            aria-live="polite"
          >
            {statusText}
          </div>
        </header>

        <Board
          board={board}
          winningLine={winningLine}
          onSquareClick={handleSquareClick}
          disabled={isOnline && !onlineRole}
        />

        <footer className="actions">
          <button className="btnPrimary" onClick={handleRestart} type="button">
            Restart
          </button>
        </footer>

        {isOnline ? (
          <p className="hintText">
            Online mode uses a peer-to-peer connection. If it fails
            (network/ICE), the game will fall back to local hotseat
            automatically.
          </p>
        ) : null}
      </section>
    </main>
  );
}

/**
 * Board: presentational; renders a 3x3 grid.
 */
function Board({ board, onSquareClick, winningLine, disabled }) {
  return (
    <div className="board" role="grid" aria-label="Tic Tac Toe board">
      {board.map((value, idx) => {
        const isWinningSquare = winningLine ? winningLine.includes(idx) : false;
        return (
          <Square
            key={idx}
            value={value}
            onClick={() => onSquareClick(idx)}
            isWinningSquare={isWinningSquare}
            ariaLabel={`Square ${idx + 1}${value ? `, ${value}` : ""}`}
            disabled={disabled}
          />
        );
      })}
    </div>
  );
}

/**
 * Square: single cell button.
 */
function Square({ value, onClick, isWinningSquare, ariaLabel, disabled }) {
  const isX = value === "X";
  const isO = value === "O";

  return (
    <button
      type="button"
      className={[
        "square",
        isX ? "isX" : "",
        isO ? "isO" : "",
        isWinningSquare ? "isWinning" : "",
      ].join(" ")}
      onClick={onClick}
      aria-label={ariaLabel}
      disabled={disabled}
    >
      <span className="squareValue" aria-hidden="true">
        {value}
      </span>
    </button>
  );
}

export default App;
