import { describe, expect, it, vi } from "vitest";
import {
  createCategoryCombobox,
  handleCategoryComboboxKeydown,
  hideCategoryCombobox,
  updateCategoryCombobox,
} from "./categoryCombobox";

function keydown(key: string): KeyboardEvent {
  return new KeyboardEvent("keydown", { key, cancelable: true });
}

function setup(options = ["Backend", "Mobile", "Voice"]) {
  const input = document.createElement("input");
  const list = document.createElement("div");
  list.id = "category-list";
  list.hidden = true;
  const accepted: string[] = [];
  const fallbackEnter = vi.fn();
  const combobox = createCategoryCombobox({
    input,
    list,
    matchOptions: query => options.filter(option => option.toLowerCase().includes(query.toLowerCase())),
    accept: value => accepted.push(value),
    fallbackEnter,
  });
  return { input, list, combobox, accepted, fallbackEnter };
}

describe("category combobox", () => {
  it("renders matched options with active descendant state", () => {
    const { input, list, combobox } = setup();
    input.value = "mo";

    updateCategoryCombobox(combobox);

    expect(list.hidden).toBe(false);
    expect(Array.from(list.querySelectorAll(".category-suggestion")).map(el => el.textContent)).toEqual(["Mobile"]);
    expect(input.getAttribute("aria-expanded")).toBe("true");
    expect(input.getAttribute("aria-activedescendant")).toBe("category-list-option-0");
  });

  it("hides when there are no options", () => {
    const { input, list, combobox } = setup();
    input.value = "missing";

    updateCategoryCombobox(combobox);

    expect(list.hidden).toBe(true);
    expect(input.getAttribute("aria-expanded")).toBe("false");
    expect(input.hasAttribute("aria-activedescendant")).toBe(false);
  });

  it("navigates with arrow keys and accepts the selected option", () => {
    const { list, combobox, accepted } = setup();
    updateCategoryCombobox(combobox, true);

    handleCategoryComboboxKeydown(combobox, keydown("ArrowDown"));
    expect(list.querySelectorAll(".category-suggestion")[1]?.className).toContain("selected");

    const enter = keydown("Enter");
    expect(handleCategoryComboboxKeydown(combobox, enter)).toBe(true);
    expect(enter.defaultPrevented).toBe(true);
    expect(accepted).toEqual(["Mobile"]);
    expect(list.hidden).toBe(true);
  });

  it("uses fallback enter when the list is hidden", () => {
    const { combobox, fallbackEnter } = setup();
    hideCategoryCombobox(combobox);

    expect(handleCategoryComboboxKeydown(combobox, keydown("Enter"))).toBe(true);
    expect(fallbackEnter).toHaveBeenCalledOnce();
  });

  it("accepts clicked options without blurring the input first", () => {
    const { list, combobox, accepted } = setup();
    updateCategoryCombobox(combobox, true);

    list.querySelector<HTMLElement>(".category-suggestion")?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));

    expect(accepted).toEqual(["Backend"]);
    expect(list.hidden).toBe(true);
  });
});
