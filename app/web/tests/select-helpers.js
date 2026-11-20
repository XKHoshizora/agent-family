// For tests of a page with the app's styled Select (src/ui/Select.jsx): its options and choosing one, as a test would
// read or change a native <select>. Synchronous: every event goes through testing-library (inside act).
import { fireEvent } from "@testing-library/react";

/** The listbox a Select's button opened (null when closed). */
const listOf = (button) => document.getElementById(button.getAttribute("aria-controls") ?? "") ?? null;

/** A Select's options as [value, text] (it is opened for it, and closed again when it was closed). */
export function optionsOf(button) {
  const wasOpen = button.getAttribute("aria-expanded") === "true";
  if (!wasOpen) fireEvent.click(button);
  const options = [...listOf(button).querySelectorAll('[role="option"]')].map((o) => [o.dataset.value, o.textContent]);
  if (!wasOpen) fireEvent.keyDown(button, { key: "Escape" });
  return options;
}

/** Opens a Select and chooses the option whose value is `value` (as a change event to a <select> would). */
export function pickOption(button, value) {
  if (button.getAttribute("aria-expanded") !== "true") fireEvent.click(button);
  const option = [...listOf(button).querySelectorAll('[role="option"]')].find((o) => o.dataset.value === String(value));
  if (!option) throw new Error(`no option ${value} in ${button.textContent}`);
  fireEvent.click(option);
}
