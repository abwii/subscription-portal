import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import Home from "./page";

describe("Home page", () => {
  it("renders the title and a call-to-action from the ui package", () => {
    render(<Home />);
    expect(screen.getByRole("heading", { level: 1, name: "monrepo" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Get started" })).toHaveAttribute(
      "data-variant",
      "primary",
    );
  });
});
