import { render, screen } from "@testing-library/react";
import App from "./App";

test("renders tic tac toe title and restart button", () => {
  render(<App />);
  expect(screen.getByText(/tic tac toe/i)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /restart/i })).toBeInTheDocument();
});
