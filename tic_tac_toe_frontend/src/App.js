import React, { useMemo, useState } from "react";
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

// PUBLIC_INTERFACE
function App() {
  return <Game />;
}

/**
 * Top-level game component: owns the game state.
 */
function Game() {
  const [board, setBoard] = useState(() => Array(9).fill(null));
  const [xIsNext, setXIsNext] = useState(true);

  const { winner, line: winningLine } = useMemo(() => calculateWinner(board), [board]);
  const isDraw = useMemo(() => !winner && board.every((c) => c !== null), [winner, board]);

  const statusText = useMemo(() => {
    // Minimal status rules: winner > draw > current player
    if (winner) return `Winner: ${winner}`;
    if (isDraw) return "Draw";
    return `Current player: ${xIsNext ? "X" : "O"}`;
  }, [winner, isDraw, xIsNext]);

  // PUBLIC_INTERFACE
  const handleSquareClick = (index) => {
    // Key game rules:
    // - Ignore clicks if the cell is already filled
    // - Ignore clicks once the game is over (win/draw)
    if (board[index] !== null || winner || isDraw) return;

    setBoard((prev) => {
      const next = prev.slice();
      next[index] = xIsNext ? "X" : "O";
      return next;
    });
    setXIsNext((prev) => !prev);
  };

  // PUBLIC_INTERFACE
  const handleRestart = () => {
    setBoard(Array(9).fill(null));
    setXIsNext(true);
  };

  return (
    <main className="app">
      <section className="gameCard" aria-label="Tic Tac Toe">
        <header className="statusHeader">
          <div className="statusTitle">Tic Tac Toe</div>
          <div
            className={`statusPill ${winner ? "isWinner" : ""} ${isDraw ? "isDraw" : ""}`}
            role="status"
            aria-live="polite"
          >
            {statusText}
          </div>
        </header>

        <Board board={board} winningLine={winningLine} onSquareClick={handleSquareClick} />

        <footer className="actions">
          <button className="btnPrimary" onClick={handleRestart} type="button">
            Restart
          </button>
        </footer>
      </section>
    </main>
  );
}

/**
 * Board: presentational; renders a 3x3 grid.
 */
function Board({ board, onSquareClick, winningLine }) {
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
          />
        );
      })}
    </div>
  );
}

/**
 * Square: single cell button.
 */
function Square({ value, onClick, isWinningSquare, ariaLabel }) {
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
    >
      <span className="squareValue" aria-hidden="true">
        {value}
      </span>
    </button>
  );
}

export default App;
