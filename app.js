const DEFAULT_REPOSITORY = "LisaExists/valenced-plugins";
const POOL_BRANCH = "gh-pages";

function getCatalogIndexUrl() {
  const host = window.location.hostname.toLowerCase();

  if (host.endsWith(".github.io")) {
    const project = window.location.pathname.split("/").filter(Boolean)[0];
    const base = project ? `/${project}/` : "/";
    return new URL("index.json", window.location.origin + base).href;
  }

  return `https://raw.githubusercontent.com/${DEFAULT_REPOSITORY}/${POOL_BRANCH}/index.json`;
}

function getRepositoryTarget() {
  const host = window.location.hostname.toLowerCase();
  if (host.endsWith(".github.io")) {
    const owner = host.slice(0, -".github.io".length);
    const firstPath = window.location.pathname.split("/").filter(Boolean)[0];
    return owner + "/" + (firstPath || owner + ".github.io");
  }
  return DEFAULT_REPOSITORY;
}

const REPOSITORY = getRepositoryTarget();
const CATALOG_INDEX_URL = getCatalogIndexUrl();
const REPOSITORY_URL = "https://github.com/" + REPOSITORY;
const grid = document.querySelector("#plugin-grid");
const searchInput = document.querySelector("#plugin-search");
const sortSelect = document.querySelector("#plugin-sort");
const catalogError = document.querySelector("#catalog-error");
const catalogStatus = document.querySelector("#catalog-status");
const toast = document.querySelector("#toast");
let catalog = [];
let toastTimer;

document.querySelectorAll("[data-repo-link]").forEach(link => {
  link.href = REPOSITORY_URL + (link.dataset.repoLink || "");
});
document.querySelectorAll("[data-catalog-index]").forEach(link => {
  link.href = CATALOG_INDEX_URL;
});

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function safeLink(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : "#";
  } catch {
    return "#";
  }
}

function compareVersions(left, right) {
  const parse = value => {
    const parts = String(value).split("-", 2);
    return { numbers: parts[0].split(".").map(part => Number.parseInt(part, 10) || 0), label: parts[1] || "" };
  };
  const a = parse(left);
  const b = parse(right);
  const length = Math.max(a.numbers.length, b.numbers.length);
  for (let i = 0; i < length; i += 1) {
    const difference = (a.numbers[i] || 0) - (b.numbers[i] || 0);
    if (difference) return difference;
  }
  if (!a.label && b.label) return 1;
  if (a.label && !b.label) return -1;
  return a.label.localeCompare(b.label);
}

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(2) + " MB";
}

function iconFor(name) {
  const known = { MicrophoneIcon: "🎙️", StickerIcon: "✧", PaletteIcon: "🎨", EmojiIcon: "🌸", FontIcon: "Aa" };
  return known[name] || "✦";
}

function getLatest(plugin) {
  const versions = Object.keys(plugin.versions || {});
  const preferred = plugin.channels?.latest;
  if (preferred && plugin.versions?.[preferred]) return preferred;
  const stable = versions.filter(version => !version.includes("-")).sort(compareVersions);
  return stable.at(-1) || versions.sort(compareVersions).at(-1) || null;
}

function dependenciesFor(data) {
  return Object.entries(data?.dependencies || {}).map(([id, config]) => {
    const version = typeof config === "string" ? config : (config?.version || "*");
    return id + " " + version;
  });
}

function renderPlugin(plugin) {
  const title = escapeHtml(plugin.name || plugin.id);
  const id = escapeHtml(plugin.id);
  const version = getLatest(plugin);
  const artifact = version ? plugin.versions?.[version] : null;
  const beta = plugin.channels?.beta && plugin.channels.beta !== plugin.channels?.latest;
  const downloadUrl = artifact?.url ? safeLink(artifact.url) : "#";
  const dependencies = dependenciesFor(artifact);
  const contributors = Array.isArray(plugin.contributors) ? plugin.contributors : [];
  const versions = Object.entries(plugin.versions || {}).sort((a, b) => compareVersions(b[0], a[0]));
  const versionRows = versions.map(([number, data]) => {
    const destination = safeLink(data?.url || "");
    const size = formatBytes(data?.size);
    return '<div class="version-row"><span>' + escapeHtml(number) + (size ? " · " + escapeHtml(size) : "") + '</span><a href="' + destination + '" target="_blank" rel="noreferrer">Download ↗</a></div>';
  }).join("");
  const dependencyHtml = dependencies.length
    ? '<div class="dependency-list" aria-label="Dependencies">' + dependencies.slice(0, 4).map(dep => '<span class="dependency" title="' + escapeHtml(dep) + '">' + escapeHtml(dep) + '</span>').join("") + "</div>"
    : "";
  const downloadHtml = artifact?.url
    ? '<a class="download-button" href="' + downloadUrl + '" target="_blank" rel="noreferrer"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.8v8.4m0 0 3.1-3.1M8 10.2 4.9 7.1M2.5 11.3v2.2h11v-2.2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>Download ZIP</a>'
    : '<span class="pill">Coming soon</span>';
  return '<article class="plugin-card" data-name="' + title.toLowerCase() + '" data-version="' + escapeHtml(version || "0") + '">' +
    '<div class="plugin-card-top"><div class="plugin-icon" aria-hidden="true">' + iconFor(plugin.icon) + '</div><div class="plugin-badges"><span class="pill pill-latest">Latest</span>' + (beta ? '<span class="pill pill-beta">Beta available</span>' : "") + '</div></div>' +
    "<h3>" + title + '</h3><div class="plugin-id">' + id + '</div>' +
    '<p class="plugin-description">' + escapeHtml(plugin.description || "No description has been added yet.") + '</p>' +
    '<div class="plugin-meta"><span>by <strong>' + escapeHtml(plugin.author || "Unknown") + '</strong></span>' +
    (contributors.length ? "<span>" + contributors.length + " contributor" + (contributors.length === 1 ? "" : "s") + "</span>" : "") +
    "<span>" + versions.length + " version" + (versions.length === 1 ? "" : "s") + "</span></div>" +
    dependencyHtml +
    '<div class="plugin-footer"><div class="version-label">Latest stable<strong>' + (version ? "v" + escapeHtml(version) : "Not published") + "</strong>" + (artifact?.size ? "<br><span>" + escapeHtml(formatBytes(artifact.size)) + "</span>" : "") + "</div>" + downloadHtml + "</div>" +
    '<details class="version-details"><summary>All published versions</summary><div class="version-list">' + (versionRows || '<span class="version-label">No versions published yet.</span>') + "</div></details></article>";
}

function updateStats(plugins) {
  const versionCount = plugins.reduce((total, plugin) => total + Object.keys(plugin.versions || {}).length, 0);
  document.querySelector("#plugin-count").textContent = String(plugins.length).padStart(2, "0");
  document.querySelector("#version-count").textContent = String(versionCount).padStart(2, "0");
}

function renderCatalog() {
  const query = searchInput.value.trim().toLocaleLowerCase();
  const filtered = catalog.filter(plugin => {
    const haystack = [plugin.name, plugin.id, plugin.description, plugin.author, ...(plugin.contributors || [])].join(" ").toLocaleLowerCase();
    return haystack.includes(query);
  });
  filtered.sort((a, b) => sortSelect.value === "updated"
    ? compareVersions(getLatest(b) || "0", getLatest(a) || "0")
    : String(a.name || a.id).localeCompare(String(b.name || b.id)));
  if (!filtered.length) {
    grid.innerHTML = '<div class="empty-card"><strong>' + (catalog.length ? "No matches just yet." : "Nothing published… yet.") + '</strong><p>' + (catalog.length ? "Try another search term." : "The plugin list will fill in as releases are published.") + "</p></div>";
    return;
  }
  grid.innerHTML = filtered.map(renderPlugin).join("");
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2300);
}

async function loadCatalog() {
  catalogError.hidden = true;
  grid.innerHTML = '<div class="loading-card"><span class="spinner"></span><p>Fetching the good stuff…</p></div>';
  catalogStatus.textContent = "Connecting to repository…";
  try {
    const response = await fetch(CATALOG_INDEX_URL, { cache: "no-store" });
    if (!response.ok) throw new Error("Index request failed: HTTP " + response.status);
    const index = await response.json();
    if (!index || typeof index.plugins !== "object" || Array.isArray(index.plugins)) throw new Error("Invalid repository index.");
    catalog = Object.entries(index.plugins).map(([id, plugin]) => Object.assign({ id }, plugin));
    updateStats(catalog);
    catalogStatus.textContent = "Repository is up to date";
    renderCatalog();
    populateIssuePlugins();
  } catch (error) {
    console.error("[lisa.plugins] Could not load index.json", error);
    catalogStatus.textContent = "Catalogue unavailable";
    document.querySelector("#plugin-count").textContent = "—";
    document.querySelector("#version-count").textContent = "—";
    catalogError.hidden = false;
    grid.innerHTML = "";
  }
}

function populateIssuePlugins() {
  const select = document.querySelector("#issue-plugin");
  const selected = select.value;
  const options = catalog.map(plugin =>
    '<option value="' + escapeHtml(plugin.id) + '">' + escapeHtml(plugin.name || plugin.id) + "</option>"
  ).join("");
  select.innerHTML =
    '<option value="" disabled>Choose a plugin…</option>' +
    options +
    '<option value="Other / repository-wide">Other / repository-wide</option>';
  if ([...select.options].some(option => option.value === selected)) {
    select.value = selected;
  } else {
    select.selectedIndex = 0;
  }
}

function openGitHubIssue(template, title, fields) {
  const url = new URL(REPOSITORY_URL + "/issues/new");
  url.searchParams.set("template", template);
  url.searchParams.set("title", title);
  for (const [id, value] of Object.entries(fields)) {
    const text = String(value ?? "").trim();
    if (text) url.searchParams.set(id, text);
  }
  if (url.href.length > 7500) {
    showToast("Your report is too long for a pre-filled link. Shorten the logs or attach them on GitHub.");
    return false;
  }
  const opened = window.open(url.toString(), "_blank", "noopener,noreferrer");
  if (!opened) {
    showToast("Your browser blocked the new tab. Allow pop-ups and submit again.");
    return false;
  }
  return true;
}

document.querySelector("#request-form").addEventListener("submit", event => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const data = new FormData(form);
  const name = String(data.get("name") || "").trim();
  const fields = {
    request_type: data.get("type"),
    plugin_name: name,
    problem: data.get("problem"),
    idea: data.get("description"),
    use_case: data.get("useCase"),
    related: data.get("related"),
    reference: data.get("reference"),
  };
  if (openGitHubIssue("plugin-request.yml", "Plugin request: " + name, fields)) {
    form.closest("dialog").close();
  }
});

document.querySelector("#issue-form").addEventListener("submit", event => {
  event.preventDefault();
  const form = event.currentTarget;
  const logsInput = document.querySelector("#issue-logs");
  logsInput.setCustomValidity("");
  if (logsInput.value.trim().length < 20) {
    logsInput.setCustomValidity("Please include at least 20 characters of relevant logs, or explain which logs you checked and why none are available.");
  }
  if (!form.reportValidity()) return;

  const data = new FormData(form);
  const title = String(data.get("title") || "").trim();
  const fields = {
    plugin: data.get("plugin"),
    plugin_version: data.get("pluginVersion"),
    valenced_version: data.get("valencedVersion"),
    discord_version: data.get("discordVersion"),
    environment: data.get("environment"),
    details: data.get("details"),
    steps: data.get("steps"),
    expected: data.get("expected"),
    logs: data.get("logs"),
    attachments: data.get("attachments"),
  };
  if (openGitHubIssue("bug-report.yml", "Bug report: " + title, fields)) {
    form.closest("dialog").close();
  }
});

document.querySelectorAll("[data-open-dialog]").forEach(button => button.addEventListener("click", () => document.getElementById(button.dataset.openDialog).showModal()));
document.querySelectorAll("[data-close-dialog]").forEach(button => button.addEventListener("click", () => button.closest("dialog").close()));
document.querySelectorAll("dialog").forEach(dialog => dialog.addEventListener("click", event => {
  if (event.target === dialog) dialog.close();
}));

function getRepositoryPageUrl() {
  const host = window.location.hostname.toLowerCase();
  if (["localhost", "127.0.0.1", "[::1]"].includes(host)) {
    const [owner, repository] = DEFAULT_REPOSITORY.split("/");
    return `https://${owner.toLowerCase()}.github.io/${repository}/`;
  }
  return new URL("./", document.baseURI).href;
}

document.querySelector("#copy-repo").addEventListener("click", async () => {
  const repositoryUrl = getRepositoryPageUrl();
  try {
    await navigator.clipboard.writeText(repositoryUrl);
    showToast("Repository URL copied ✨");
  } catch {
    showToast(repositoryUrl);
  }
});

document.querySelector("#retry-catalog").addEventListener("click", loadCatalog);
searchInput.addEventListener("input", renderCatalog);
sortSelect.addEventListener("change", renderCatalog);
document.querySelector("#mobile-menu").addEventListener("click", event => {
  const nav = document.querySelector(".main-nav");
  const expanded = event.currentTarget.getAttribute("aria-expanded") === "true";
  event.currentTarget.setAttribute("aria-expanded", String(!expanded));
  nav.classList.toggle("open", !expanded);
});
document.querySelectorAll(".main-nav a").forEach(link => link.addEventListener("click", () => {
  document.querySelector(".main-nav").classList.remove("open");
  document.querySelector("#mobile-menu").setAttribute("aria-expanded", "false");
}));
document.addEventListener("keydown", event => {
  if (event.key === "/" && !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)) {
    event.preventDefault();
    searchInput.focus();
  }
});

loadCatalog();
