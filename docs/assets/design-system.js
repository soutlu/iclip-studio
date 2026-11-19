// 色阶与语义映射都从本页第一个 <style> 的 :root / .dark 解析，本页不另存一份 manifest。
const displayedTones = ["0", "10", "20", "30", "40", "50", "60", "70", "80", "90", "95", "99", "100"];
const palettes = [
  { name: "Primary", prefix: "P", cssPrefix: "p" },
  { name: "Tertiary", prefix: "T", cssPrefix: "t" },
  { name: "Error", prefix: "E", cssPrefix: "e" },
  { name: "Neutral", prefix: "N", cssPrefix: "n" },
];

const tokenSource = document.querySelector("style").textContent;
const readBlock = (selector) => {
  const start = tokenSource.indexOf(`${selector} {`);
  const end = tokenSource.indexOf("\n      }", start);
  const map = new Map();
  for (const match of tokenSource.slice(start, end).matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) {
    if (!map.has(match[1])) map.set(match[1], match[2].trim());
  }
  return map;
};
const lightTokens = readBlock(":root");
const darkTokens = readBlock(".dark");
const tokenValue = (name, theme) =>
  (theme === "dark" && darkTokens.get(name)) || lightTokens.get(name);

// 把 var(--p80) 写成 P80、var(--color-tertiary) 写成 = tertiary，字面值原样返回
const referenceLabel = (name, theme) => {
  const value = tokenValue(name, theme);
  if (!value) return "—";
  const tone = value.match(/^var\(--(p|t|e|n)(\d+)\)$/);
  if (tone) return `${tone[1].toUpperCase()}${tone[2]}`;
  const alias = value.match(/^var\(--color-([\w-]+)\)$/);
  if (alias) return `= ${alias[1]}`;
  return value;
};

// label · role · foreground role
const family = (name, role) => ({
  name,
  items: [
    [name, role, `on-${role}`],
    [`On ${name}`, `on-${role}`, role],
    [`${name} Container`, `${role}-container`, `on-${role}-container`],
    [`On ${name} Container`, `on-${role}-container`, `${role}-container`],
  ],
});

const accentIndexes = [1, 2, 3, 4, 5, 6, 7, 8];

const semanticGroups = [
  {
    id: "core",
    title: "Core color roles",
    description: "品牌、中性次级、状态与容器关系",
    columns: ["Default", "On", "Container", "On container"],
    families: [
      family("Primary", "primary"),
      family("Secondary", "secondary"),
      family("Tertiary", "tertiary"),
      family("Error", "error"),
      family("Warning", "warning"),
    ],
  },
  {
    id: "actions",
    title: "Actions & workbench materials",
    description: "主色悬停、墨色次主按钮、统一浮起卡片与凹陷控件槽",
    families: [
      {
        name: "Actions",
        items: [
          ["Primary Hover", "primary-hover", "on-primary"],
          ["Action Neutral", "action-neutral", "on-action-neutral"],
          ["On Action Neutral", "on-action-neutral", "action-neutral"],
        ],
      },
      {
        name: "Materials",
        items: [
          ["Card", "card", "on-surface"],
          ["Card Edge", "card-edge", "on-surface"],
          ["Control Well", "control-well", "on-surface"],
        ],
      },
    ],
  },
  {
    id: "tones",
    title: "Categorical & media tones",
    description: "低饱和分类/媒体语义色（明暗成对换档，在卡片与凹槽底上均 ≥ AA；主要用于线条、波形与双色图标，实底徽标配 --color-on-tone）",
    families: [
      {
        name: "5 Tones",
        items: [
          ["Slate · 镜头/原声", "tone-slate", "on-tone"],
          ["Teal · 配乐/字幕", "tone-teal", "on-tone"],
          ["Umber · 人声/稿件", "tone-umber", "on-tone"],
          ["Copper · 贴片/指向", "tone-copper", "on-tone"],
          ["Ochre · 场景/包络", "tone-ochre", "on-tone"],
        ],
      },
      {
        name: "Pairing",
        items: [["On Tone · 分类实底配字", "on-tone", "tone-slate"]],
      },
    ],
  },
  {
    id: "fixed",
    title: "Fixed roles",
    description: "跨主题保持稳定的品牌容器",
    columns: ["Fixed", "Fixed dim", "On fixed", "On fixed variant"],
    families: ["primary", "secondary", "tertiary"].map((role) => {
      const Role = role[0].toUpperCase() + role.slice(1);
      return {
        name: Role,
        items: [
          [`${Role} Fixed`, `${role}-fixed`, `on-${role}-fixed`],
          [`${Role} Fixed Dim`, `${role}-fixed-dim`, `on-${role}-fixed`],
          [`On ${Role} Fixed`, `on-${role}-fixed`, `${role}-fixed`],
          [`On ${Role} Fixed Variant`, `on-${role}-fixed-variant`, `${role}-fixed`],
        ],
      };
    }),
  },
  {
    id: "accent",
    title: "Shot accents",
    description: "只表达镜头身份：时间轴色段与序号旁短色签同色",
    families: [
      {
        name: "Segment",
        items: accentIndexes.map((n) => [`Accent ${n}`, `accent-${n}`, "on-scrim"]),
      },
    ],
  },
  {
    id: "surface",
    title: "Surface hierarchy",
    description: "背景层级、内容、描边与反色",
    families: [
      {
        name: "Surface",
        items: [
          ["Surface", "surface", "on-surface"],
          ["Surface Variant", "surface-variant", "on-surface-variant"],
          ["Background", "background", "on-background"],
        ],
      },
      {
        name: "Container ramp",
        items: [
          ["Container Lowest", "surface-container-lowest", "on-surface"],
          ["Container Low", "surface-container-low", "on-surface"],
          ["Container", "surface-container", "on-surface"],
          ["Container High", "surface-container-high", "on-surface"],
          ["Container Highest", "surface-container-highest", "on-surface"],
        ],
      },
      {
        name: "Content & border",
        items: [
          ["On Surface", "on-surface", "surface"],
          ["On Surface Variant", "on-surface-variant", "surface"],
          ["On Surface Muted", "on-surface-muted", "surface"],
          ["On Surface Faint", "on-surface-faint", "surface"],
          ["Outline", "outline", "surface"],
          ["Outline Variant", "outline-variant", "on-surface"],
          ["Hairline", "hairline", "on-surface"],
        ],
      },
      {
        name: "Inverse & effects",
        items: [
          ["Inverse Surface", "inverse-surface", "inverse-on-surface"],
          ["Inverse On Surface", "inverse-on-surface", "inverse-surface"],
          ["Inverse Primary", "inverse-primary", "inverse-surface"],
          ["Scrim", "scrim", "on-scrim"],
          ["Shadow", "shadow", "on-scrim"],
        ],
      },
      {
        name: "State layers",
        items: [
          ["Hover", "state-hover", "on-surface"],
          ["Focus", "state-focus", "on-surface"],
          ["Pressed", "state-pressed", "on-surface"],
          ["Dragged", "state-dragged", "on-surface"],
          ["Disabled Container", "disabled-container", "disabled-text"],
          ["Focus Ring", "focus-ring", "surface"],
        ],
      },
    ],
  },
];

const paletteStack = document.querySelector("#palette-stack");
const semanticPanel = document.querySelector("#semantic-panel");
const semanticGroupsRoot = document.querySelector("#semantic-groups");
const themeButtons = [...document.querySelectorAll("[data-theme]")];
const toast = document.querySelector("#toast");
const rootStyles = getComputedStyle(document.documentElement);
let toastTimer;

const referenceVariable = (cssPrefix, tone) => `--${cssPrefix}${tone}`;
const resolveReference = (cssPrefix, tone) =>
  rootStyles.getPropertyValue(referenceVariable(cssPrefix, tone)).trim().toUpperCase();

const readableText = (hex) => {
  const value = hex.replace("#", "");
  const toLinear = (channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  const luminance =
    0.2126 * toLinear(Number.parseInt(value.slice(0, 2), 16)) +
    0.7152 * toLinear(Number.parseInt(value.slice(2, 4), 16)) +
    0.0722 * toLinear(Number.parseInt(value.slice(4, 6), 16));
  const blackContrast = (luminance + 0.05) / 0.05;
  const whiteContrast = 1.05 / (luminance + 0.05);
  return blackContrast >= whiteContrast ? "#000000" : "#FFFFFF";
};

const copyValue = async (value, message) => {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    // 离线 file:// 剪贴板权限受限时仍弹出提示
  }
  toast.textContent = message;
  toast.classList.add("show");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("show"), 1400);
};
const copyTokenValue = (token, value) => copyValue(value, `${token} · ${value} 已复制`);
const copySemanticToken = (role) => copyValue(`--color-${role}`, `--color-${role} 已复制`);

palettes.forEach((palette) => {
  const row = document.createElement("div");
  row.className = "palette-row";
  const name = document.createElement("span");
  name.className = "palette-name";
  name.textContent = `${palette.name} · ${palette.prefix}`;
  const strip = document.createElement("div");
  strip.className = "tone-strip";
  displayedTones.forEach((tone) => {
    const token = `${palette.prefix}${tone}`;
    const value = resolveReference(palette.cssPrefix, tone);
    const swatch = document.createElement("button");
    swatch.type = "button";
    swatch.className = "tone";
    swatch.textContent = tone;
    swatch.title = `--${palette.cssPrefix}${tone} · ${value}`;
    swatch.setAttribute("aria-label", `复制 token ${token} 的解析值 ${value}`);
    swatch.style.setProperty("--tone", `var(${referenceVariable(palette.cssPrefix, tone)})`);
    swatch.style.setProperty("--tone-label", readableText(value));
    swatch.addEventListener("click", () => copyTokenValue(token, value));
    strip.append(swatch);
  });
  row.append(name, strip);
  paletteStack.append(row);
});

const makeTokenCell = ([label, role, foreground], theme) => {
  const semanticToken = `--color-${role}`;
  const cell = document.createElement("button");
  cell.type = "button";
  cell.className = "token-cell";
  cell.title = `复制 ${semanticToken}`;
  cell.setAttribute(
    "aria-label",
    `复制语义 token ${semanticToken}，${theme === "light" ? "浅色" : "深色"}映射 ${referenceLabel(`color-${role}`, theme)}`,
  );
  cell.style.setProperty("--cell-bg", `var(${semanticToken})`);
  cell.style.setProperty("--cell-fg", `var(--color-${foreground})`);
  cell.innerHTML = `
    <strong>${label}</strong>
    <code>${semanticToken}</code>
    <span class="token-reference">→ ${referenceLabel(`color-${role}`, theme)}</span>
  `;
  cell.addEventListener("click", () => copySemanticToken(role));
  return cell;
};

const renderSemanticGroups = (theme) => {
  const fragment = document.createDocumentFragment();
  semanticGroups.forEach((group) => {
    const section = document.createElement("section");
    section.className = "token-group";
    section.setAttribute("aria-labelledby", `${group.id}-title`);
    const header = document.createElement("header");
    header.className = "token-group__header";
    const titleBlock = document.createElement("div");
    titleBlock.innerHTML = `<h4 id="${group.id}-title">${group.title}</h4><p>${group.description}</p>`;
    header.append(titleBlock);
    if (group.columns) {
      const columns = document.createElement("div");
      columns.className = "token-columns";
      columns.style.setProperty("--columns", group.columns.length);
      group.columns.forEach((label) => {
        const column = document.createElement("span");
        column.textContent = label;
        columns.append(column);
      });
      header.append(columns);
    }
    section.append(header);
    group.families.forEach((fam) => {
      const familyRow = document.createElement("article");
      familyRow.className = "token-family";
      const familyName = document.createElement("h5");
      familyName.textContent = fam.name;
      const cells = document.createElement("div");
      cells.className = "token-family__cells";
      cells.dataset.count = fam.items.length;
      cells.style.setProperty("--columns", fam.items.length);
      fam.items.forEach((item) => cells.append(makeTokenCell(item, theme)));
      familyRow.append(familyName, cells);
      section.append(familyRow);
    });
    fragment.append(section);
  });
  semanticGroupsRoot.replaceChildren(fragment);
};

// 深色即给面板加 .dark：语义 token 在页面里也只走同一套变量换档
const selectTheme = (theme) => {
  semanticPanel.classList.remove("theme-light", "theme-dark", "dark");
  semanticPanel.classList.add(`theme-${theme}`);
  if (theme === "dark") semanticPanel.classList.add("dark");
  semanticGroupsRoot.setAttribute("aria-labelledby", `theme-tab-${theme}`);
  themeButtons.forEach((button) => {
    const selected = button.dataset.theme === theme;
    button.setAttribute("aria-selected", String(selected));
    button.tabIndex = selected ? 0 : -1;
  });
  renderSemanticGroups(theme);
};

themeButtons.forEach((button, index) => {
  button.addEventListener("click", () => selectTheme(button.dataset.theme));
  button.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    const direction = event.key === "ArrowRight" ? 1 : -1;
    const nextIndex = (index + direction + themeButtons.length) % themeButtons.length;
    themeButtons[nextIndex].focus();
    selectTheme(themeButtons[nextIndex].dataset.theme);
  });
});

// 渲染图标 5 档真实像素尺寸预览
document.querySelectorAll("[data-icon-px]").forEach((box) => {
  const px = box.dataset.iconPx;
  box.innerHTML = `<svg width="${px}" height="${px}" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <rect x="3" y="5" width="18" height="14" rx="2.5" stroke="currentColor" stroke-width="1.7"/>
    <path d="M10 9.5l5 2.5-5 2.5v-5Z" fill="currentColor"/>
  </svg>`;
});

// 动效时值实时播放演示
const playMotionBtn = document.querySelector("#play-motion");
if (playMotionBtn) {
  const motionTracks = [...document.querySelectorAll("#motion-demo .motion-track")];
  let motionResetTimer;
  playMotionBtn.addEventListener("click", () => {
    window.clearTimeout(motionResetTimer);
    motionTracks.forEach((t) => t.classList.remove("is-running"));
    void playMotionBtn.offsetWidth;
    motionTracks.forEach((t) => t.classList.add("is-running"));
    motionResetTimer = window.setTimeout(() => {
      motionTracks.forEach((t) => t.classList.remove("is-running"));
    }, 720);
  });
}

selectTheme("light");
