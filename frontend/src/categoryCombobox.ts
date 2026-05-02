export type CategoryCombobox = {
  input: HTMLInputElement;
  list: HTMLDivElement;
  selectedIndex: number;
  options: string[];
  accept: (value: string) => void;
  fallbackEnter: () => void;
  matchOptions: (query: string) => string[];
};

type CategoryComboboxOptions = {
  input: HTMLInputElement;
  list: HTMLDivElement;
  matchOptions: (query: string) => string[];
  accept: (value: string) => void;
  fallbackEnter: () => void;
};

export function createCategoryCombobox(options: CategoryComboboxOptions): CategoryCombobox {
  const combobox: CategoryCombobox = {
    input: options.input,
    list: options.list,
    selectedIndex: -1,
    options: [],
    accept: options.accept,
    fallbackEnter: options.fallbackEnter,
    matchOptions: options.matchOptions,
  };
  combobox.input.addEventListener("input", () => updateCategoryCombobox(combobox));
  combobox.input.addEventListener("focus", () => updateCategoryCombobox(combobox, true));
  combobox.input.addEventListener("blur", () => window.setTimeout(() => hideCategoryCombobox(combobox), 120));
  return combobox;
}

export function updateCategoryCombobox(combobox: CategoryCombobox, showAll = false): void {
  const query = showAll ? "" : combobox.input.value;
  const options = combobox.matchOptions(query).slice(0, 8);
  combobox.options = options;
  combobox.selectedIndex = options.length > 0 ? 0 : -1;
  renderCategoryCombobox(combobox);
}

export function hideCategoryCombobox(combobox: CategoryCombobox): void {
  combobox.list.hidden = true;
  combobox.input.setAttribute("aria-expanded", "false");
  combobox.input.removeAttribute("aria-activedescendant");
}

export function renderCategoryCombobox(combobox: CategoryCombobox): void {
  combobox.list.replaceChildren();
  if (combobox.options.length === 0) {
    hideCategoryCombobox(combobox);
    return;
  }

  for (const [index, option] of combobox.options.entries()) {
    const row = combobox.list.ownerDocument.createElement("div");
    const optionId = `${combobox.list.id}-option-${index}`;
    row.id = optionId;
    row.className = `category-suggestion${index === combobox.selectedIndex ? " selected" : ""}`;
    row.role = "option";
    row.setAttribute("aria-selected", String(index === combobox.selectedIndex));
    row.textContent = option;
    row.addEventListener("mousedown", event => {
      event.preventDefault();
      combobox.accept(option);
      hideCategoryCombobox(combobox);
    });
    combobox.list.append(row);
  }
  combobox.list.hidden = false;
  combobox.input.setAttribute("aria-expanded", "true");
  const active = combobox.selectedIndex >= 0 ? `${combobox.list.id}-option-${combobox.selectedIndex}` : null;
  if (active) combobox.input.setAttribute("aria-activedescendant", active);
  else combobox.input.removeAttribute("aria-activedescendant");
}

export function handleCategoryComboboxKeydown(combobox: CategoryCombobox, event: KeyboardEvent): boolean {
  if (event.key === "ArrowDown") {
    event.preventDefault();
    if (combobox.list.hidden) updateCategoryCombobox(combobox, true);
    else if (combobox.options.length > 0) {
      combobox.selectedIndex = (combobox.selectedIndex + 1) % combobox.options.length;
      renderCategoryCombobox(combobox);
    }
    return true;
  }
  if (event.key === "ArrowUp") {
    event.preventDefault();
    if (combobox.list.hidden) updateCategoryCombobox(combobox, true);
    else if (combobox.options.length > 0) {
      combobox.selectedIndex = (combobox.selectedIndex - 1 + combobox.options.length) % combobox.options.length;
      renderCategoryCombobox(combobox);
    }
    return true;
  }
  if (event.key === "Enter" && !combobox.list.hidden && combobox.selectedIndex >= 0) {
    event.preventDefault();
    combobox.accept(combobox.options[combobox.selectedIndex]);
    hideCategoryCombobox(combobox);
    return true;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    combobox.fallbackEnter();
    return true;
  }
  if (event.key === "Escape" && !combobox.list.hidden) {
    event.preventDefault();
    hideCategoryCombobox(combobox);
    return true;
  }
  return false;
}
