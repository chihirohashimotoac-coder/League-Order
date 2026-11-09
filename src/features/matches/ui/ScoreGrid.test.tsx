import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { ZeroOneGrid } from "./ScoreGrid";
import type { LiveThrow } from "../parse";

afterEach(cleanup);

const visit = (
  side: 0 | 1,
  round: number,
  score: number,
  left: number,
  extra: Partial<Extract<LiveThrow, { kind: "01" }>> = {},
): LiveThrow => ({
  kind: "01",
  side,
  round,
  score,
  left,
  darts: 3,
  finish: false,
  member: null,
  ...extra,
});

// Left (side 0) checks out 29 with the second dart in round 3; right is on 52.
const leg = {
  first: 0 as const,
  start: [301, 301] as [number, number],
  throws: [
    visit(0, 1, 140, 161),
    visit(1, 1, 100, 201),
    visit(0, 2, 132, 29),
    visit(1, 2, 149, 52),
    visit(0, 3, 29, 0, { finish: true, darts: 2 }),
  ],
};

const rows = (container: HTMLElement): string[][] =>
  [...container.querySelectorAll("tbody tr")].map((row) =>
    [...row.querySelectorAll("td")].map((cell) => cell.textContent ?? ""),
  );

describe("ZeroOneGrid (n01 score sheet)", () => {
  it("counts darts in the middle column (3, 6, 9 …) and starts from the start row", () => {
    const { container } = render(<ZeroOneGrid leg={leg} />);
    expect(rows(container).map((row) => row[2])).toEqual(["", "3", "6", "9"]);
    expect(rows(container)[0]).toEqual(["", "301", "", "", "301"]);
  });

  it("writes the finish as x1 / x2 / x3 in the Scored cell, never 0 in To Go, and does not circle it", () => {
    const { container } = render(<ZeroOneGrid leg={leg} />);
    const finish = rows(container)[3];
    expect(finish.slice(0, 2)).toEqual(["x2", ""]);
    expect(container.querySelector("td.out")?.getAttribute("aria-label")).toBe(
      "29 で上がり (2本目)",
    );
    expect(container.querySelector("td.out")?.classList.contains("ton")).toBe(
      false,
    );
    expect(container.textContent).not.toMatch(/(^|\D)0(\D|$)/);
  });

  it("circles every visit of 100 or more (n01 circleTon), and only those", () => {
    const { container } = render(
      <ZeroOneGrid
        leg={{ ...leg, throws: [...leg.throws, visit(1, 3, 99, 7)] }}
      />,
    );
    const circled = [...container.querySelectorAll("td.ton")].map(
      (cell) => cell.textContent,
    );
    expect(circled).toEqual(["140", "100", "132", "149"]);
  });

  it("keeps the columns in card order and marks the first thrower", () => {
    const { container } = render(
      <ZeroOneGrid leg={leg} order={[1, 0]} names={["B", "A"]} />,
    );
    expect(
      [...container.querySelectorAll("tr.names th")].map(
        (cell) => cell.textContent,
      ),
    ).toEqual(["B", "", "* A"]);
    expect(rows(container)[1]).toEqual(["100", "201", "3", "140", "161"]);
    expect(rows(container)[3].slice(3)).toEqual(["x2", ""]);
  });

  it("live: highlights the cell the next visit goes into and keeps a spare row", () => {
    const live = { ...leg, throws: leg.throws.slice(0, 3) };
    const { container } = render(
      <ZeroOneGrid leg={live} thrower={1} minRows={4} spare={1} />,
    );
    expect(rows(container)).toHaveLength(5);
    const waiting = container.querySelector("td.waiting");
    expect(waiting?.closest("tr")?.querySelector("td.mid")?.textContent).toBe(
      "6",
    );
  });
});
