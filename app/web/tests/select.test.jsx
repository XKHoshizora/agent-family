// @vitest-environment jsdom
// The app's styled Select for plain choices (src/ui/Select.jsx): a button that opens a list of options, used with the
// keyboard as the model picker is (no search: typing jumps to an option), the value held by its caller.
import React, { useState } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Select } from "../src/ui/Select.jsx";
import { optionsOf, pickOption } from "./select-helpers.js";

afterEach(cleanup);

const NOTES = [
  { value: "auto", label: "自动判断要不要进保险箱" },
  { value: "vault", label: "全部进保险箱" },
  { value: "held", label: "暂时不能选的", disabled: true, hint: "暂不可用" },
  { value: "open", label: "全部不进保险箱" },
];
const LANGS = [
  { value: "auto", label: "自动" },
  { value: "en", label: "English" },
  { value: "es", label: "Español" },
  { value: "fr", label: "Français" },
];

/** A field with its label and a Select whose value the field holds; `onChange` hears every change. */
function Field({ options = NOTES, initial = "auto", onChange = () => {}, ...rest }) {
  const [value, setValue] = useState(initial);
  return (
    <div>
      <label htmlFor="pick">新记下的内容</label>
      <Select
        id="pick"
        listLabel="新记下的内容"
        value={value}
        options={options}
        onChange={(next) => {
          setValue(next);
          onChange(next);
        }}
        {...rest}
      />
      <button type="button">别处</button>
    </div>
  );
}
const button = () => screen.getByRole("combobox", { name: "新记下的内容" });
const list = () => screen.queryByRole("listbox");
const key = (k) => fireEvent.keyDown(button(), { key: k });
const active = () => document.getElementById(button().getAttribute("aria-activedescendant") ?? "");

describe("Select", () => {
  it("is a combobox button showing the chosen option, its value on it; closed, no list", () => {
    render(<Field initial="vault" />);
    expect(button().tagName).toBe("BUTTON");
    expect(button().getAttribute("aria-haspopup")).toBe("listbox");
    expect(button().getAttribute("aria-expanded")).toBe("false");
    expect(button().textContent).toBe("全部进保险箱");
    expect(button().value).toBe("vault");
    expect(list()).toBeNull();
  });

  it("a click opens its list (named as its field), the chosen option marked and where the keyboard is; the focus stays on the button", () => {
    render(<Field initial="vault" />);
    button().focus();
    fireEvent.click(button());
    expect(button().getAttribute("aria-expanded")).toBe("true");
    expect(list().getAttribute("aria-label")).toBe("新记下的内容");
    expect(button().getAttribute("aria-controls")).toBe(list().id);
    const options = [...list().querySelectorAll('[role="option"]')];
    expect(options.map((o) => o.textContent)).toEqual(["自动判断要不要进保险箱", "全部进保险箱", "暂时不能选的暂不可用", "全部不进保险箱"]);
    expect(options.map((o) => o.getAttribute("aria-selected"))).toEqual(["false", "true", "false", "false"]);
    expect(active()).toBe(options[1]);
    expect(document.activeElement).toBe(button());
  });

  it("↑/↓ move over the options that can be chosen, Home/End to the ends; Enter chooses once and closes", () => {
    const onChange = vi.fn();
    render(<Field onChange={onChange} />);
    button().focus();
    key("ArrowDown");
    expect(list()).not.toBeNull();
    expect(active().textContent).toBe("自动判断要不要进保险箱");
    key("ArrowDown");
    expect(active().textContent).toBe("全部进保险箱");
    key("ArrowDown");
    // 暂时不能选的 is skipped.
    expect(active().textContent).toBe("全部不进保险箱");
    key("ArrowDown");
    expect(active().textContent).toBe("全部不进保险箱");
    key("Home");
    expect(active().textContent).toBe("自动判断要不要进保险箱");
    key("End");
    expect(active().textContent).toBe("全部不进保险箱");
    key("Enter");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("open");
    expect(list()).toBeNull();
    expect(button().textContent).toBe("全部不进保险箱");
    expect(button().value).toBe("open");
    expect(document.activeElement).toBe(button());
  });

  it("Space opens and chooses too, and the click a Space ends with does not open it again", () => {
    const onChange = vi.fn();
    render(<Field onChange={onChange} />);
    key(" ");
    expect(list()).not.toBeNull();
    key("ArrowDown");
    key(" ");
    fireEvent.keyUp(button(), { key: " " });
    fireEvent.click(button());
    expect(onChange).toHaveBeenCalledWith("vault");
    expect(list()).toBeNull();
  });

  it("choosing the option already chosen changes nothing", () => {
    const onChange = vi.fn();
    render(<Field onChange={onChange} />);
    pickOption(button(), "auto");
    expect(onChange).not.toHaveBeenCalled();
    expect(list()).toBeNull();
  });

  it("typing jumps to the option that begins with what was typed", () => {
    render(<Field options={LANGS} />);
    fireEvent.click(button());
    key("f");
    expect(active().textContent).toBe("Français");
    key("e");
    expect(active().textContent).toBe("English");
    key("s");
    expect(active().textContent).toBe("Español");
  });

  it("Esc closes and leaves the value; Tab closes without choosing; a press outside closes", () => {
    const onChange = vi.fn();
    render(<Field onChange={onChange} />);
    button().focus();
    key("ArrowDown");
    key("ArrowDown");
    key("Escape");
    expect(list()).toBeNull();
    expect(document.activeElement).toBe(button());
    key("ArrowDown");
    key("ArrowDown");
    key("Tab");
    expect(list()).toBeNull();
    fireEvent.click(button());
    fireEvent.pointerDown(screen.getByRole("button", { name: "别处" }));
    expect(list()).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    expect(button().value).toBe("auto");
  });

  it("an option that cannot be chosen says why and cannot be chosen", () => {
    const onChange = vi.fn();
    render(<Field onChange={onChange} />);
    fireEvent.click(button());
    const held = [...list().querySelectorAll('[role="option"]')].find((o) => o.dataset.value === "held");
    expect(held.getAttribute("aria-disabled")).toBe("true");
    expect(held.getAttribute("title")).toBe("暂不可用");
    fireEvent.click(held);
    expect(onChange).not.toHaveBeenCalled();
    expect(list()).not.toBeNull();
  });

  it("disabled, it does not open; a value it does not offer shows the placeholder", () => {
    render(<Field disabled />);
    expect(button().disabled).toBe(true);
    fireEvent.click(button());
    expect(list()).toBeNull();
    cleanup();
    render(<Field initial={null} placeholder="正在读取…" />);
    expect(button().textContent).toBe("正在读取…");
    expect(button().value).toBe("");
  });

  it("takes the field's description and error state", () => {
    render(<Field aria-describedby="hint" aria-invalid />);
    expect(button().getAttribute("aria-describedby")).toBe("hint");
    expect(button().getAttribute("aria-invalid")).toBe("true");
  });

  it("the test helpers read and choose as on a native select", () => {
    const onChange = vi.fn();
    render(<Field onChange={onChange} />);
    expect(optionsOf(button())).toEqual([
      ["auto", "自动判断要不要进保险箱"],
      ["vault", "全部进保险箱"],
      ["held", "暂时不能选的暂不可用"],
      ["open", "全部不进保险箱"],
    ]);
    expect(list()).toBeNull();
    pickOption(button(), "vault");
    expect(onChange).toHaveBeenCalledWith("vault");
  });

  it("looks like the model picker's field: the same button, popover and rows, a sheet on a phone that is only as tall as its options", () => {
    const css = readFileSync(resolve(__dirname, "../src/styles.css"), "utf8");
    expect(css).toMatch(/\.model-trigger, \.select-trigger\s*\{/);
    expect(css).toMatch(/\.model-pop, \.select-pop\s*\{/);
    expect(css).toMatch(/\.model-option, \.select-option\s*\{/);
    const phone = css.slice(css.indexOf("/* A phone: the list is a sheet"));
    expect(phone).toMatch(/\.select-pop[^{]*\{[^}]*height:\s*auto/);
  });
});
