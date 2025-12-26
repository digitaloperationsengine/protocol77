"use client";

import React, { useMemo, useReducer, useEffect, useCallback } from "react";

type Suit = "Spade" | "Heart" | "Diamond" | "Club" | "Crown" | "Key" | "Star";
type Phase = "LOBBY" | "PLAYER" | "DEALER" | "DONE";

type Card = {
  suit: Suit;
  value: number; // 1..11
  rank: number; // 1 = highest
  id: string; // `${Suit}-${value}`
};

type LogEntry = {
  at: number; // epoch ms
  kind: string;
  note: string;
  snapshot: {
    seed: number;
    phase: Phase;
    deck: number;
    bankroll: number;
    bet: number;
    playerTotal: number;
    dealerTotal: number;
    playerHand: string[];
    dealerHand: string[];
  };
};

const SUITS: Suit[] = ["Spade", "Heart", "Diamond", "Club", "Crown", "Key", "Star"];
const SUIT_RANK: Record<Suit, number> = {
  Spade: 1,
  Heart: 2,
  Diamond: 3,
  Club: 4,
  Crown: 5,
  Key: 6,
  Star: 7,
};
const VALUES = Array.from({ length: 11 }, (_, i) => i + 1);

const BUST = 21.0;
const DEALER_STAND = 17.0;

// Betting (beta rules)
const MAX_BET = 50;

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

function cryptoSeed32(): number {
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  return (arr[0] >>> 0) || 1;
}

function buildDeck(): Card[] {
  const deck: Card[] = [];
  for (const suit of SUITS) {
    for (const v of VALUES) {
      deck.push({
        suit,
        value: v,
        rank: SUIT_RANK[suit],
        id: `${suit}-${v}`,
      });
    }
  }
  return deck; // 77 unique
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const r = new Uint32Array(1);
    crypto.getRandomValues(r);
    const j = r[0] % (i + 1);
    const tmp = a[i];
    a[i] = a[j];
    a[j] = tmp;
  }
  return a;
}

function cardScore(c: Card): number {
  return round2(c.value + c.rank / 100);
}

function handTotal(hand: Card[]): number {
  return round2(hand.reduce((sum, c) => sum + cardScore(c), 0));
}

function clampBet(n: number) {
  if (n < 0) return 0;
  if (n > MAX_BET) return MAX_BET;
  return n;
}

function hasDuplicatesById(cards: Card[]): boolean {
  const seen = new Set<string>();
  for (const c of cards) {
    if (seen.has(c.id)) return true;
    seen.add(c.id);
  }
  return false;
}

// Bulletproof draw: never returns duplicate ids vs inPlay or within a take.
function takeUnique(deck: Card[], n: number, inPlay: Set<string>): { taken: Card[]; rest: Card[] } {
  let d = [...deck];
  const taken: Card[] = [];
  const takenIds = new Set<string>();

  // If deck is corrupted, rebuild immediately (minus inPlay).
  if (hasDuplicatesById(d)) {
    d = shuffle(buildDeck().filter((c) => !inPlay.has(c.id)));
  }

  let safety = 0;
  while (taken.length < n) {
    safety++;
    if (safety > 500) {
      const allBlocked = new Set<string>([...inPlay, ...takenIds]);
      d = shuffle(buildDeck().filter((c) => !allBlocked.has(c.id)));
      safety = 0;
    }

    if (d.length === 0) {
      const allBlocked = new Set<string>([...inPlay, ...takenIds]);
      d = shuffle(buildDeck().filter((c) => !allBlocked.has(c.id)));
      continue;
    }

    const c = d.shift()!;
    if (inPlay.has(c.id)) continue;
    if (takenIds.has(c.id)) continue;

    taken.push(c);
    takenIds.add(c.id);
    inPlay.add(c.id);
  }

  return { taken, rest: d };
}

type State = {
  seed: number;
  phase: Phase;

  deck: Card[];
  playerHand: Card[];
  dealerHand: Card[];

  bankroll: number;
  bet: number;

  message: string;

  // Only if player is busted on initial deal (first 2 cards)
  playerInitialBust: boolean;

  // UX/devtools
  log: LogEntry[];
  logOpen: boolean;
};

type Action =
  | { type: "RESET_RUN" }
  | { type: "SHUFFLE" }
  | { type: "TOGGLE_LOG" }
  | { type: "RESET_BET" }
  | { type: "BET_ADD"; inc: number }
  | { type: "BET_PLACE_CTA" }
  | { type: "START" }
  | { type: "DRAW"; n: 1 | 2 }
  | { type: "STAND" }
  | { type: "DEALER_PLAY" }
  | { type: "NEXT_HAND" };

const initialState: State = {
  seed: cryptoSeed32(),
  phase: "LOBBY",
  deck: shuffle(buildDeck()),
  playerHand: [],
  dealerHand: [],
  bankroll: 10000,
  bet: 0,
  message: "Place a bet to join the table.",
  playerInitialBust: false,
  log: [],
  logOpen: false,
};

function snapshotOf(state: State) {
  return {
    seed: state.seed,
    phase: state.phase,
    deck: state.deck.length,
    bankroll: state.bankroll,
    bet: state.bet,
    playerTotal: handTotal(state.playerHand),
    dealerTotal: handTotal(state.dealerHand),
    playerHand: state.playerHand.map((c) => c.id),
    dealerHand: state.dealerHand.map((c) => c.id),
  };
}

function pushLog(state: State, kind: string, note: string): State {
  const entry: LogEntry = {
    at: Date.now(),
    kind,
    note,
    snapshot: snapshotOf(state),
  };
  const next = [...state.log, entry];
  // keep it lightweight
  const capped = next.length > 200 ? next.slice(next.length - 200) : next;
  return { ...state, log: capped };
}

// Normalize: if anything ends up duplicated in hands, drop dupes and rebuild deck excluding in-play.
// This is a safety net so you never SEE the dupe bug even if HMR does something weird.
function normalize(state: State): State {
  const dedupeHand = (hand: Card[]) => {
    const seen = new Set<string>();
    const out: Card[] = [];
    for (const c of hand) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      out.push(c);
    }
    return out;
  };

  const p = dedupeHand(state.playerHand);
  const d = dedupeHand(state.dealerHand);

  const inPlay = new Set<string>();
  for (const c of p) inPlay.add(c.id);
  for (const c of d) inPlay.add(c.id);

  let deckOk = !hasDuplicatesById(state.deck);
  if (deckOk) {
    for (const c of state.deck) {
      if (inPlay.has(c.id)) {
        deckOk = false;
        break;
      }
    }
  }

  const deck = deckOk ? state.deck : shuffle(buildDeck().filter((c) => !inPlay.has(c.id)));

  // If no changes, return original reference (keeps UI stable).
  const sameP = p.length === state.playerHand.length && p.every((c, i) => c.id === state.playerHand[i]?.id);
  const sameD = d.length === state.dealerHand.length && d.every((c, i) => c.id === state.dealerHand[i]?.id);
  const sameDeck = deck === state.deck;
  if (sameP && sameD && sameDeck) return state;

  return { ...state, playerHand: p, dealerHand: d, deck };
}

function reducer(state0: State, action: Action): State {
  let state = normalize(state0);

  switch (action.type) {
    case "RESET_RUN": {
      const reset: State = {
        ...initialState,
        seed: cryptoSeed32(),
        deck: shuffle(buildDeck()),
        message: "Place a bet to join the table.",
      };
      return pushLog(reset, "RESET_RUN", "Reset run.");
    }

    case "TOGGLE_LOG": {
      return { ...state, logOpen: !state.logOpen };
    }

    case "SHUFFLE": {
      const inPlay = new Set<string>();
      for (const c of state.playerHand) inPlay.add(c.id);
      for (const c of state.dealerHand) inPlay.add(c.id);
      const safeDeck = buildDeck().filter((c) => !inPlay.has(c.id));

      const next = {
        ...state,
        seed: cryptoSeed32(),
        deck: shuffle(safeDeck),
        message:
          state.phase === "PLAYER"
            ? state.playerInitialBust
              ? "Dealt bust. Only STAND is allowed."
              : "Your turn. Draw 2, Draw 1, or Stand."
            : state.phase === "LOBBY"
            ? "Place a bet to join the table."
            : state.message,
      };
      return pushLog(next, "SHUFFLE", "Shuffled deck (excluding in-play).");
    }

    case "RESET_BET": {
      if (state.phase !== "LOBBY") return state;
      const next = { ...state, bet: 0, message: "Place a bet to join the table." };
      return pushLog(next, "RESET_BET", "Reset bet to 0.");
    }

    case "BET_ADD": {
      if (state.phase !== "LOBBY") return state;
      const nextBet = clampBet(state.bet + action.inc);
      const next = {
        ...state,
        bet: nextBet,
        message: nextBet > 0 ? "Bet set. Press START to deal." : "Place a bet to join the table.",
      };
      return pushLog(next, "BET_ADD", `Bet +${action.inc} -> ${nextBet}.`);
    }

    case "BET_PLACE_CTA": {
      if (state.phase !== "LOBBY") return state;
      const nextBet = state.bet > 0 ? state.bet : 10;
      const next = { ...state, bet: nextBet, message: "Bet set. Press START to deal." };
      return pushLog(next, "BET_PLACE_CTA", `CTA placed bet -> ${nextBet}.`);
    }

    case "START": {
      if (state.phase !== "LOBBY") return state;
      if (state.bet <= 0) return pushLog({ ...state, message: "You must place a bet first." }, "START_BLOCKED", "Start blocked: no bet.");
      if (state.bet > state.bankroll) return pushLog({ ...state, message: "Bet exceeds bankroll." }, "START_BLOCKED", "Start blocked: bet > bankroll.");

      const inPlay = new Set<string>();
      const { taken, rest } = takeUnique(state.deck, 4, inPlay);

      const p = [taken[0], taken[2]];
      const d = [taken[1], taken[3]];

      const pTot = handTotal(p);
      const initBust = pTot > BUST;

      const next: State = {
        ...state,
        phase: "PLAYER",
        deck: rest,
        playerHand: p,
        dealerHand: d,
        playerInitialBust: initBust,
        message: initBust ? "Dealt bust. Only STAND is allowed." : "Your turn. Draw 2, Draw 1, or Stand.",
      };

      return pushLog(next, "START", `Dealt. Player ${pTot.toFixed(2)}${initBust ? " (dealt bust)" : ""}.`);
    }

    case "DRAW": {
      if (state.phase !== "PLAYER") return state;

      // If player was dealt bust, they may NOT draw (rule you approved).
      if (state.playerInitialBust) {
        const next = { ...state, message: "Dealt bust. Only STAND is allowed." };
        return pushLog(next, "DRAW_BLOCKED", "Draw blocked: dealt bust.");
      }

      const currentP = handTotal(state.playerHand);
      if (currentP > BUST) return state;

      const inPlay = new Set<string>();
      for (const c of state.playerHand) inPlay.add(c.id);
      for (const c of state.dealerHand) inPlay.add(c.id);

      const { taken, rest } = takeUnique(state.deck, action.n, inPlay);
      const nextHand = [...state.playerHand, ...taken];
      const pt = handTotal(nextHand);

      if (pt > BUST) {
        const next: State = {
          ...state,
          phase: "DONE",
          deck: rest,
          playerHand: nextHand,
          message: `You bust (${pt.toFixed(2)}). You lose. (-${state.bet} sats)`,
          bankroll: state.bankroll - state.bet,
        };
        return pushLog(next, "BUST_BY_HIT", `Player bust by hit at ${pt.toFixed(2)} (-${state.bet}).`);
      }

      const next: State = {
        ...state,
        deck: rest,
        playerHand: nextHand,
        message: "Your turn. Draw 2, Draw 1, or Stand.",
      };

      return pushLog(next, "DRAW", `Player drew ${action.n}. Total now ${pt.toFixed(2)}.`);
    }

    case "STAND": {
      if (state.phase !== "PLAYER") return state;
      const next = { ...state, phase: "DEALER", message: "Dealer plays..." };
      return pushLog(next, "STAND", "Player stands. Dealer phase.");
    }

    case "DEALER_PLAY": {
      if (state.phase !== "DEALER") return state;

      let deck = state.deck;
      let dh = [...state.dealerHand];

      const inPlayBase = new Set<string>();
      for (const c of state.playerHand) inPlayBase.add(c.id);
      for (const c of dh) inPlayBase.add(c.id);

      // Ensure dealer has 2 cards (should already)
      if (dh.length < 2) {
        const { taken, rest } = takeUnique(deck, 2 - dh.length, inPlayBase);
        dh = [...dh, ...taken];
        deck = rest;
      }

      let dt = handTotal(dh);
      let draws = 0;
      while (dt < DEALER_STAND) {
        const inPlay = new Set<string>();
        for (const c of state.playerHand) inPlay.add(c.id);
        for (const c of dh) inPlay.add(c.id);

        const { taken, rest } = takeUnique(deck, 1, inPlay);
        dh = [...dh, taken[0]];
        deck = rest;
        dt = handTotal(dh);
        draws++;
        if (draws > 50) break; // absolute safety guard, should never hit
      }

      const pt = handTotal(state.playerHand);
      const dealerBust = dt > BUST;

      // Special rule (your approved rule):
      // - If player is DEALT bust (initial 2 cards) they can ONLY win if dealer busts.
      // - If player busts by hitting, they already lost in DRAW and cannot reach here.
      if (state.playerInitialBust) {
        if (dealerBust) {
          const next: State = {
            ...state,
            phase: "DONE",
            deck,
            dealerHand: dh,
            message: `Dealer busts (${dt.toFixed(2)}). You win. (+${state.bet} sats)`,
            bankroll: state.bankroll + state.bet,
          };
          return pushLog(next, "DEALT_BUST_WIN", `Dealt-bust exception win (dealer bust ${dt.toFixed(2)}). +${state.bet}.`);
        }
        const next: State = {
          ...state,
          phase: "DONE",
          deck,
          dealerHand: dh,
          message: `You were dealt bust (${pt.toFixed(2)}). Dealer stands (${dt.toFixed(2)}). You lose. (-${state.bet} sats)`,
          bankroll: state.bankroll - state.bet,
        };
        return pushLog(next, "DEALT_BUST_LOSS", `Dealt-bust loss (dealer ${dt.toFixed(2)}). -${state.bet}.`);
      }

      if (dealerBust) {
        const next: State = {
          ...state,
          phase: "DONE",
          deck,
          dealerHand: dh,
          message: `Dealer busts (${dt.toFixed(2)}). You win. (+${state.bet} sats)`,
          bankroll: state.bankroll + state.bet,
        };
        return pushLog(next, "DEALER_BUST_WIN", `Dealer bust ${dt.toFixed(2)}. +${state.bet}.`);
      }

      if (pt > dt) {
        const next: State = {
          ...state,
          phase: "DONE",
          deck,
          dealerHand: dh,
          message: `You win. (P ${pt.toFixed(2)} vs D ${dt.toFixed(2)}) (+${state.bet} sats)`,
          bankroll: state.bankroll + state.bet,
        };
        return pushLog(next, "WIN", `Win P ${pt.toFixed(2)} vs D ${dt.toFixed(2)}. +${state.bet}.`);
      }

      if (pt < dt) {
        const next: State = {
          ...state,
          phase: "DONE",
          deck,
          dealerHand: dh,
          message: `You lose. (P ${pt.toFixed(2)} vs D ${dt.toFixed(2)}) (-${state.bet} sats)`,
          bankroll: state.bankroll - state.bet,
        };
        return pushLog(next, "LOSS", `Loss P ${pt.toFixed(2)} vs D ${dt.toFixed(2)}. -${state.bet}.`);
      }

      const next: State = {
        ...state,
        phase: "DONE",
        deck,
        dealerHand: dh,
        message: `Push. (P ${pt.toFixed(2)} vs D ${dt.toFixed(2)}) (+0 sats)`,
      };
      return pushLog(next, "PUSH", `Push P ${pt.toFixed(2)} vs D ${dt.toFixed(2)}.`);
    }

    case "NEXT_HAND": {
      if (state.phase !== "DONE") return state;
      const next: State = {
        ...state,
        phase: "LOBBY",
        bet: 0,
        playerHand: [],
        dealerHand: [],
        playerInitialBust: false,
        message: "Place a bet to join the table.",
      };
      return pushLog(next, "NEXT_HAND", "Next hand -> lobby.");
    }

    default:
      return state;
  }
}

export default function Home() {
  const [state, dispatch] = useReducer(reducer, initialState);

  // Auto-run dealer when phase enters DEALER (single source of truth)
  useEffect(() => {
    if (state.phase === "DEALER") {
      dispatch({ type: "DEALER_PLAY" });
    }
  }, [state.phase]);

  const playerTotal = useMemo(() => handTotal(state.playerHand), [state.playerHand]);
  const dealerTotal = useMemo(() => handTotal(state.dealerHand), [state.dealerHand]);

  const showDealerDown = state.phase === "DEALER" || state.phase === "DONE";
  const dealerUp = state.dealerHand[0] ?? null;
  const dealerDown = state.dealerHand[1] ?? null;

  const dealerUpTotal = useMemo(() => (dealerUp ? round2(cardScore(dealerUp)) : 0), [dealerUp]);

  const dealerBig = useMemo(() => {
    if (!dealerUp) return "0.00";
    return showDealerDown ? dealerTotal.toFixed(2) : dealerUpTotal.toFixed(2);
  }, [dealerUp, dealerTotal, dealerUpTotal, showDealerDown]);

  // Header now matches what's shown.
  const dealerTitle = showDealerDown ? "DEALER TOTAL" : "DEALER UP-CARD TOTAL";

  // Controls state
  const canBet = state.phase === "LOBBY";
  const canStart = state.phase === "LOBBY" && state.bet > 0 && state.bet <= state.bankroll;
  const canDraw = state.phase === "PLAYER" && !state.playerInitialBust; // dealt-bust blocks draw
  const canStand = state.phase === "PLAYER";
  const canNextHand = state.phase === "DONE";

  // Button tooltips (microcopy)
  const startTip =
    state.phase !== "LOBBY"
      ? "Only available in the lobby."
      : state.bet <= 0
      ? "Place a bet first."
      : state.bet > state.bankroll
      ? "Bet exceeds bankroll."
      : "Deal the hand.";
  const drawTip =
    state.phase !== "PLAYER"
      ? "Only available during your turn."
      : state.playerInitialBust
      ? "Dealt bust - only STAND is allowed."
      : "Draw cards.";
  const standTip = state.phase !== "PLAYER" ? "Only available during your turn." : "End your turn. Dealer plays.";

  const dealerCardsToRender: Array<{ key: string; card: Card | null; hiddenSlot?: boolean }> = useMemo(() => {
    if (state.dealerHand.length === 0) return [];
    const list: Array<{ key: string; card: Card | null; hiddenSlot?: boolean }> = [];

    if (dealerUp) list.push({ key: `up-${dealerUp.id}`, card: dealerUp });

    if (showDealerDown) {
      if (dealerDown) list.push({ key: `down-${dealerDown.id}`, card: dealerDown });
      for (let i = 2; i < state.dealerHand.length; i++) {
        const c = state.dealerHand[i];
        list.push({ key: `ex-${c.id}-${i}`, card: c });
      }
    } else {
      list.push({ key: "down-hidden", card: null, hiddenSlot: true });
    }
    return list;
  }, [state.dealerHand, dealerUp, dealerDown, showDealerDown]);

  const copyRunDebug = useCallback(async () => {
    const payload = {
      version: "p77-beta",
      createdAt: new Date().toISOString(),
      state: {
        seed: state.seed,
        phase: state.phase,
        deckCount: state.deck.length,
        bankroll: state.bankroll,
        bet: state.bet,
        playerHand: state.playerHand,
        dealerHand: state.dealerHand,
        playerInitialBust: state.playerInitialBust,
        message: state.message,
      },
      log: state.log,
    };

    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
      dispatch({ type: "TOGGLE_LOG" }); // quick “feedback” via UI state change
      // reopen to original state after a beat
      setTimeout(() => dispatch({ type: "TOGGLE_LOG" }), 120);
    } catch {
      // fallback: do nothing (no alerts, keep UI clean)
    }
  }, [state]);

  // Keyboard shortcuts (product polish)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      const typing = tag === "input" || tag === "textarea" || (target as any)?.isContentEditable;
      if (typing) return;

      const k = e.key.toLowerCase();

      if (k === "s") {
        if (canStart) dispatch({ type: "START" });
        return;
      }
      if (k === "1") {
        if (canDraw) dispatch({ type: "DRAW", n: 1 });
        return;
      }
      if (k === "2") {
        if (canDraw) dispatch({ type: "DRAW", n: 2 });
        return;
      }
      if (k === " " || k === "enter") {
        if (canStand) {
          e.preventDefault();
          dispatch({ type: "STAND" });
        }
        return;
      }
      if (k === "n") {
        if (canNextHand) dispatch({ type: "NEXT_HAND" });
        return;
      }
      if (k === "r") {
        dispatch({ type: "RESET_RUN" });
        return;
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [canStart, canDraw, canStand, canNextHand]);

  return (
    <div className="p77">
      <div className="hero">
        <div className="title">PROTOCOL 77 - TABLE</div>
        <div className="sub">PRESS START</div>
        <div className={`status ${state.phase === "DONE" ? "done" : state.phase === "LOBBY" ? "ready" : "live"}`}>
          STATUS: {state.phase === "LOBBY" ? "READY" : state.phase === "DONE" ? "DONE" : "LIVE"}
        </div>

        <div className="panel">
          <div className="chipsRow">
            <div className="chip">Seed: {state.seed}</div>
            <div className="chip">Deck: {state.deck.length}</div>
            <div className="chip">Phase: {state.phase}</div>
            <div className="chip">Bankroll: {state.bankroll} sats</div>
            <div className="chip">
              Bet: {state.bet}
              {state.phase !== "LOBBY" ? " (locked)" : ""}
            </div>
          </div>

          {state.phase === "LOBBY" && state.bet === 0 && (
            <div className="ctaRow">
              <div className="ctaText">Choose a bet to unlock the table.</div>
              <button className="ctaBtn" onClick={() => dispatch({ type: "BET_PLACE_CTA" })}>
                PLACE BET TO JOIN TABLE
              </button>
            </div>
          )}

          <div className="controls">
            <div className="betGroup">
              <div className="label">BET</div>

              <button
                className="btn"
                disabled={!canBet || state.bet >= MAX_BET}
                title={!canBet ? "Betting is only available in the lobby." : state.bet >= MAX_BET ? "Max bet reached." : "Add 10 sats."}
                onClick={() => dispatch({ type: "BET_ADD", inc: 10 })}
              >
                +10
              </button>
              <button
                className="btn"
                disabled={!canBet || state.bet >= MAX_BET}
                title={!canBet ? "Betting is only available in the lobby." : state.bet >= MAX_BET ? "Max bet reached." : "Add 21 sats."}
                onClick={() => dispatch({ type: "BET_ADD", inc: 21 })}
              >
                +21
              </button>
              <button
                className="btn"
                disabled={!canBet || state.bet >= MAX_BET}
                title={!canBet ? "Betting is only available in the lobby." : state.bet >= MAX_BET ? "Max bet reached." : "Add 50 sats (caps at max bet)."}
                onClick={() => dispatch({ type: "BET_ADD", inc: 50 })}
              >
                +50
              </button>
              <button
                className="btn"
                disabled={!canBet || state.bet === 0}
                title={!canBet ? "Betting is only available in the lobby." : state.bet === 0 ? "Nothing to reset." : "Reset bet to 0."}
                onClick={() => dispatch({ type: "RESET_BET" })}
              >
                RESET BET
              </button>

              <div className="rules">Max bet: {MAX_BET} sats.</div>
            </div>

            <div className="actionGroup">
              <button className="btnPrimary" disabled={!canStart} title={startTip} onClick={() => dispatch({ type: "START" })}>
                START
              </button>
              <button
                className="btnPrimary"
                disabled={!canDraw}
                title={drawTip + " (Shortcut: 2)"}
                onClick={() => dispatch({ type: "DRAW", n: 2 })}
              >
                DRAW 2
              </button>
              <button
                className="btnPrimary"
                disabled={!canDraw}
                title={drawTip + " (Shortcut: 1)"}
                onClick={() => dispatch({ type: "DRAW", n: 1 })}
              >
                DRAW 1
              </button>
              <button className="btnPrimary" disabled={!canStand} title={standTip + " (Shortcut: Space)"} onClick={() => dispatch({ type: "STAND" })}>
                STAND
              </button>

              <button className="btn" title="Shuffle remaining deck (keeps in-play cards safe)." onClick={() => dispatch({ type: "SHUFFLE" })}>
                SHUFFLE
              </button>
              <button className="btn" title="Copy a debug JSON payload to reproduce this run fast." onClick={copyRunDebug}>
                COPY RUN DEBUG
              </button>
              <button className="btn" title="Toggle the event log (debug history)." onClick={() => dispatch({ type: "TOGGLE_LOG" })}>
                {state.logOpen ? "HIDE LOG" : "SHOW LOG"}
              </button>
              <button className="btnDanger" title="Hard reset everything (Shortcut: R)." onClick={() => dispatch({ type: "RESET_RUN" })}>
                RESET RUN
              </button>
              <button className="btn" disabled={!canNextHand} title={!canNextHand ? "Only available after a hand finishes." : "Start the next hand (Shortcut: N)."} onClick={() => dispatch({ type: "NEXT_HAND" })}>
                NEXT HAND
              </button>
            </div>
          </div>

          <div className="desc">
            77-card core deck (7 suits x 11 values). Bust threshold: {BUST.toFixed(2)}. Dealer stands at {DEALER_STAND.toFixed(0)}+. Dealer draws 1 at a time. Player can draw only 2 / 1. Dealer: 1 up, 1 down until dealer phase.
            <span className="kbdHint"> Shortcuts: S=start, 1/2=draw, Space=stand, N=next hand, R=reset.</span>
          </div>

          {state.logOpen && (
            <div className="logPanel">
              <div className="logHeader">
                <div className="logTitle">EVENT LOG</div>
                <div className="logMeta">{state.log.length} events (latest last)</div>
              </div>

              <div className="logBody">
                {state.log.length === 0 ? (
                  <div className="logEmpty">No events yet. Place a bet and start a hand.</div>
                ) : (
                  state.log
                    .slice()
                    .reverse()
                    .map((e, i) => (
                      <div key={`${e.at}-${i}`} className="logRow">
                        <div className="logLeft">
                          <div className="logKind">{e.kind}</div>
                          <div className="logNote">{e.note}</div>
                        </div>
                        <div className="logRight">
                          <div className="logStamp">{new Date(e.at).toLocaleTimeString()}</div>
                          <div className="logSnap">
                            P {e.snapshot.playerTotal.toFixed(2)} | D {e.snapshot.dealerTotal.toFixed(2)} | Deck {e.snapshot.deck} | Bet {e.snapshot.bet}
                          </div>
                        </div>
                      </div>
                    ))
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="msg">{state.message}</div>

      <div className="grid">
        <div className="box">
          <div className="boxTitle">PLAYER TOTAL</div>
          <div className="big">{playerTotal.toFixed(2)}</div>
          <div className="small">Bust at {BUST.toFixed(2)}</div>

          <div className="cards">
            {state.playerHand.length === 0 ? (
              <div className="empty">Place a bet, then press START to deal.</div>
            ) : (
              state.playerHand.map((c, idx) => (
                <div key={`p-${c.id}-${idx}`} className="card">
                  <div className="cardTop">
                    <div className="suit">{c.suit}</div>
                    <div className="val">{c.value}</div>
                  </div>
                  <div className="meta">
                    Rank {c.rank} - Value {c.value}
                  </div>
                  <div className="meta">ID: {c.id}</div>
                  <div className="meta">Card score: {cardScore(c).toFixed(2)}</div>
                  <div className="art">No art yet</div>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="box">
          <div className="boxTitle">{dealerTitle}</div>
          <div className="big">{dealerBig}</div>
          <div className="small">{showDealerDown ? "Revealed" : "Up-card shown, down-card hidden"}</div>

          <div className="cards">
            {state.dealerHand.length === 0 ? (
              <div className="empty">Dealer is waiting.</div>
            ) : (
              dealerCardsToRender.map((slot) => {
                if (slot.hiddenSlot) {
                  return (
                    <div key={slot.key} className="card hiddenCard">
                      <div className="cardTop">
                        <div className="suit">Hidden</div>
                        <div className="val">??</div>
                      </div>
                      <div className="meta">Rank ? - Value ?</div>
                      <div className="meta">ID: Hidden</div>
                      <div className="meta">Card score: ??</div>
                      <div className="art">Hidden</div>
                    </div>
                  );
                }

                const c = slot.card!;
                return (
                  <div key={slot.key} className="card">
                    <div className="cardTop">
                      <div className="suit">{c.suit}</div>
                      <div className="val">{c.value}</div>
                    </div>
                    <div className="meta">
                      Rank {c.rank} - Value {c.value}
                    </div>
                    <div className="meta">ID: {c.id}</div>
                    <div className="meta">Card score: {cardScore(c).toFixed(2)}</div>
                    <div className="art">No art yet</div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>

      <style jsx>{`
        .p77 {
          min-height: 100vh;
          color: #e9e9ea;
          background: radial-gradient(60% 50% at 50% 0%, rgba(255, 0, 0, 0.18), rgba(0, 0, 0, 0.95) 60%), #000;
          padding: 36px 22px 60px;
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
        }
        .hero {
          max-width: 1100px;
          margin: 0 auto;
          text-align: center;
        }
        .title {
          font-size: 56px;
          letter-spacing: 10px;
          color: #ff2b2b;
          text-shadow: 0 0 22px rgba(255, 0, 0, 0.25);
          margin-top: 10px;
        }
        .sub {
          margin-top: 10px;
          letter-spacing: 5px;
          opacity: 0.7;
        }
        .status {
          margin-top: 8px;
          letter-spacing: 3px;
          font-size: 14px;
        }
        .status.live,
        .status.ready {
          color: #37f7c5;
        }
        .status.done {
          color: #ffb3b3;
        }

        .panel {
          margin: 22px auto 10px;
          max-width: 980px;
          border-radius: 22px;
          background: rgba(10, 10, 10, 0.65);
          border: 1px solid rgba(255, 255, 255, 0.08);
          box-shadow: 0 0 0 1px rgba(255, 0, 0, 0.12) inset, 0 20px 60px rgba(0, 0, 0, 0.6);
          padding: 18px 18px 14px;
        }
        .chipsRow {
          display: flex;
          gap: 10px;
          flex-wrap: wrap;
          justify-content: center;
          margin-bottom: 14px;
        }
        .chip {
          padding: 8px 12px;
          border-radius: 999px;
          border: 1px solid rgba(255, 255, 255, 0.1);
          background: rgba(0, 0, 0, 0.5);
          font-size: 13px;
          opacity: 0.95;
        }

        .ctaRow {
          display: flex;
          gap: 12px;
          justify-content: center;
          align-items: center;
          padding: 12px;
          margin: 8px 0 14px;
          border-radius: 16px;
          border: 1px solid rgba(255, 0, 0, 0.18);
          background: rgba(0, 0, 0, 0.55);
          box-shadow: 0 0 0 1px rgba(255, 0, 0, 0.06) inset;
          flex-wrap: wrap;
        }
        .ctaText {
          opacity: 0.85;
          letter-spacing: 1px;
        }
        .ctaBtn {
          cursor: pointer;
          padding: 12px 16px;
          border-radius: 999px;
          border: 1px solid rgba(255, 255, 255, 0.16);
          background: rgba(0, 0, 0, 0.75);
          color: #fff;
          letter-spacing: 2px;
          font-size: 13px;
          transition: transform 0.05s ease, border-color 0.15s ease, opacity 0.15s ease;
        }
        .ctaBtn:active {
          transform: translateY(1px);
        }

        .controls {
          display: grid;
          grid-template-columns: 1fr;
          gap: 14px;
        }
        .betGroup,
        .actionGroup {
          display: flex;
          flex-wrap: wrap;
          gap: 10px;
          justify-content: center;
          align-items: center;
        }
        .label {
          opacity: 0.7;
          letter-spacing: 3px;
          margin-right: 6px;
          font-size: 13px;
        }
        .rules {
          opacity: 0.65;
          font-size: 12px;
          margin-left: 8px;
        }

        .btn,
        .btnPrimary,
        .btnDanger {
          cursor: pointer;
          padding: 12px 16px;
          border-radius: 999px;
          border: 1px solid rgba(255, 255, 255, 0.12);
          background: rgba(0, 0, 0, 0.55);
          color: #fff;
          letter-spacing: 2px;
          font-size: 13px;
          transition: transform 0.05s ease, border-color 0.15s ease, opacity 0.15s ease;
          user-select: none;
        }
        .btnPrimary {
          border-color: rgba(255, 255, 255, 0.18);
          background: rgba(0, 0, 0, 0.7);
        }
        .btnDanger {
          border-color: rgba(255, 50, 50, 0.55);
          box-shadow: 0 0 0 1px rgba(255, 0, 0, 0.15) inset;
        }
        .btn:active,
        .btnPrimary:active,
        .btnDanger:active {
          transform: translateY(1px);
        }
        .btn:disabled,
        .btnPrimary:disabled,
        .btnDanger:disabled {
          opacity: 0.35;
          cursor: not-allowed;
        }

        .desc {
          margin-top: 10px;
          opacity: 0.75;
          font-size: 13px;
          line-height: 1.4;
        }
        .kbdHint {
          opacity: 0.75;
          margin-left: 8px;
        }

        .logPanel {
          margin-top: 14px;
          border-radius: 18px;
          border: 1px solid rgba(255, 255, 255, 0.08);
          background: rgba(0, 0, 0, 0.5);
          box-shadow: 0 0 0 1px rgba(255, 0, 0, 0.06) inset;
          overflow: hidden;
          text-align: left;
        }
        .logHeader {
          display: flex;
          justify-content: space-between;
          align-items: baseline;
          padding: 12px 14px;
          border-bottom: 1px solid rgba(255, 255, 255, 0.06);
        }
        .logTitle {
          letter-spacing: 6px;
          font-size: 12px;
          opacity: 0.85;
        }
        .logMeta {
          font-size: 12px;
          opacity: 0.6;
        }
        .logBody {
          max-height: 260px;
          overflow: auto;
          padding: 8px;
        }
        .logEmpty {
          padding: 14px;
          opacity: 0.7;
        }
        .logRow {
          display: flex;
          justify-content: space-between;
          gap: 12px;
          padding: 10px 10px;
          border-radius: 12px;
          border: 1px solid rgba(255, 255, 255, 0.06);
          background: rgba(0, 0, 0, 0.35);
          margin: 8px 0;
        }
        .logLeft {
          min-width: 0;
        }
        .logKind {
          letter-spacing: 2px;
          font-size: 12px;
          opacity: 0.95;
        }
        .logNote {
          font-size: 12px;
          opacity: 0.7;
          margin-top: 4px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          max-width: 540px;
        }
        .logRight {
          text-align: right;
          white-space: nowrap;
        }
        .logStamp {
          font-size: 12px;
          opacity: 0.65;
        }
        .logSnap {
          font-size: 12px;
          opacity: 0.7;
          margin-top: 4px;
        }

        .msg {
          max-width: 980px;
          margin: 18px auto 0;
          padding: 14px 16px;
          border-radius: 14px;
          background: rgba(0, 0, 0, 0.65);
          border: 1px solid rgba(255, 0, 0, 0.18);
          box-shadow: 0 0 0 1px rgba(255, 0, 0, 0.08) inset;
          text-align: center;
          letter-spacing: 1px;
        }

        .grid {
          max-width: 1100px;
          margin: 18px auto 0;
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 18px;
        }
        @media (max-width: 920px) {
          .grid {
            grid-template-columns: 1fr;
          }
          .title {
            font-size: 40px;
            letter-spacing: 7px;
          }
        }
        .box {
          border-radius: 22px;
          background: rgba(10, 10, 10, 0.6);
          border: 1px solid rgba(255, 255, 255, 0.08);
          padding: 18px;
          box-shadow: 0 18px 50px rgba(0, 0, 0, 0.55);
        }
        .boxTitle {
          opacity: 0.75;
          letter-spacing: 6px;
          font-size: 13px;
          margin-bottom: 10px;
        }
        .big {
          font-size: 56px;
          letter-spacing: 2px;
          margin-bottom: 6px;
        }
        .small {
          opacity: 0.7;
          margin-bottom: 14px;
        }
        .cards {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 12px;
        }
        @media (max-width: 520px) {
          .cards {
            grid-template-columns: 1fr;
          }
          .big {
            font-size: 46px;
          }
        }
        .card {
          border-radius: 18px;
          background: rgba(0, 0, 0, 0.55);
          border: 1px solid rgba(255, 255, 255, 0.09);
          padding: 14px;
          min-height: 150px;
          position: relative;
          box-shadow: 0 0 0 1px rgba(255, 0, 0, 0.06) inset;
        }
        .cardTop {
          display: flex;
          justify-content: space-between;
          align-items: baseline;
          margin-bottom: 10px;
        }
        .suit {
          letter-spacing: 3px;
          opacity: 0.9;
        }
        .val {
          font-size: 32px;
          opacity: 0.95;
        }
        .meta {
          opacity: 0.75;
          font-size: 12px;
          line-height: 1.35;
          margin-top: 3px;
        }
        .art {
          margin-top: 10px;
          border-radius: 14px;
          border: 1px dashed rgba(255, 255, 255, 0.14);
          padding: 14px;
          text-align: center;
          opacity: 0.55;
        }
        .hiddenCard {
          opacity: 0.9;
        }
        .empty {
          grid-column: 1 / -1;
          padding: 18px;
          border-radius: 16px;
          border: 1px dashed rgba(255, 255, 255, 0.16);
          text-align: center;
          opacity: 0.7;
        }
      `}</style>
    </div>
  );
}
