const { CompositeDisposable, Disposable } = require("lumine");
const { shell } = require("electron");
const path = require("path");
const fs = require("fs");
const CSON = require("@lumine-code/season");
const searchForPattern = require("./search-pattern");

const CACHE_UPDATED_CHANNEL = "fuzzy-explorer:cache-updated";

module.exports = {
  openExternalService: null,
  nativeClipService: null,
  ignores: [],
  Ignores: [],
  items: [],
  pending: false,
  building: false,
  separator: 0,
  selectList: null,
  disposables: null,
  cacheUpdateSubscription: null,
  cacheFingerprint: null,
  recentlyUsed: [],
  recentCount: 0,

  activate(state) {
    this.cacheUpdateSubscription = new Disposable();
    this.recentlyUsed = [
      ...new Set(
        (Array.isArray(state?.recentlyUsed) ? state.recentlyUsed : []).filter(
          (aPath) => typeof aPath === "string",
        ),
      ),
    ];
    this.recentCount = lumine.config.get("fuzzy-explorer.recentCount");
    this.trimRecent();

    this.selectList = lumine.workspace.buildSelectList({
      className: "fuzzy-explorer",
      crumb: "Explorer",
      emptyMessage: "No matches found",
      removeDiacritics: true,
      algorithm: "command-t",
      elementForItem: (item, options) => this.elementForItem(item, options),
      didConfirmSelection: () => this.performAction("open"),
      didCancelSelection: () => this.selectList.hide(),
      willShow: () => this.updateView(true),
      // The recent section is the one thing some rows have and others do not,
      // so its action is offered only while such a row is selected.
      actionsFilter: ({ name }) =>
        name !== "fuzzy-explorer:remove-from-recent" ||
        this.isRecent(this.selectList.getSelectedItem()),
    });

    this.disposables = new CompositeDisposable(
      lumine.config.observe("fuzzy-explorer.separator", (value) => {
        this.separator = value;
      }),
      lumine.config.onDidChange("fuzzy-explorer.recentCount", ({ newValue }) => {
        this.recentCount = newValue;
        if (this.trimRecent()) this.refreshRecent();
      }),
      lumine.commands.add("lumine-workspace", {
        "fuzzy-explorer:toggle": () => this.selectList.toggle(),
        "fuzzy-explorer:refresh": {
          description: "Read the explorer configuration again and rebuild the list.",
          didDispatch: () => this.build(),
        },
        "fuzzy-explorer:edit": {
          description: "Open the configuration that decides what the list offers.",
          didDispatch: () => this.editConfig(),
        },
        "fuzzy-explorer:clear-recent": {
          description: "Forget the recently used entries kept at the top of the list.",
          didDispatch: () => this.clearRecent(),
        },
      }),
      // Registered in the package's own namespace: the item-actions list
      // (F12) derives its rows — label, description, keybinding — from these
      // registrations and the keymap, so nothing is documented twice. Every
      // description says something the humanized command name does not.
      lumine.commands.add(this.selectList.element, {
        "fuzzy-explorer:open": {
          description: "Open the file, or continue the query into a directory.",
          didDispatch: () => this.performAction("open"),
        },
        "fuzzy-explorer:open-external": {
          description: "Open the file in the default external program.",
          didDispatch: () => this.performAction("open-external"),
        },
        "fuzzy-explorer:show-in-folder": {
          description: "Show the file in the system file manager.",
          didDispatch: () => this.performAction("show-in-folder"),
        },
        "fuzzy-explorer:split-left": {
          description: "Open the file in a pane to the left.",
          didDispatch: () => this.performAction("split", { side: "left" }),
        },
        "fuzzy-explorer:split-right": {
          description: "Open the file in a pane to the right.",
          didDispatch: () => this.performAction("split", { side: "right" }),
        },
        "fuzzy-explorer:split-up": {
          description: "Open the file in a pane above.",
          didDispatch: () => this.performAction("split", { side: "up" }),
        },
        "fuzzy-explorer:split-down": {
          description: "Open the file in a pane below.",
          didDispatch: () => this.performAction("split", { side: "down" }),
        },
        "fuzzy-explorer:insert-absolute-path": {
          description: "Insert the full path from the filesystem root into the active editor.",
          didDispatch: () => this.performAction("path", { op: "insert", rel: "a" }),
        },
        "fuzzy-explorer:insert-relative-path": {
          description: "Insert the path relative to the active editor.",
          didDispatch: () => this.performAction("path", { op: "insert", rel: "r" }),
        },
        "fuzzy-explorer:insert-file-name": {
          description: "Insert the base name, without its directories, into the active editor.",
          didDispatch: () => this.performAction("path", { op: "insert", rel: "n" }),
        },
        "fuzzy-explorer:copy-absolute-path": {
          description: "Copy the full path from the filesystem root to the clipboard.",
          didDispatch: () => this.performAction("path", { op: "copy", rel: "a" }),
        },
        "fuzzy-explorer:copy-relative-path": {
          description: "Copy the path relative to the active editor.",
          didDispatch: () => this.performAction("path", { op: "copy", rel: "r" }),
        },
        "fuzzy-explorer:copy-file-name": {
          description: "Copy the base name, without its directories, to the clipboard.",
          didDispatch: () => this.performAction("path", { op: "copy", rel: "n" }),
        },
        "fuzzy-explorer:refresh-index": {
          description: "Scan the configured glob patterns again and rebuild the index.",
          actionScope: "list",
          didDispatch: () => this.update(),
        },
        "fuzzy-explorer:use-default-separator": {
          description: "Use the platform path separator.",
          actionScope: "list",
          didDispatch: () => {
            lumine.config.set("fuzzy-explorer.separator", 0);
            lumine.notifications.addHint("Separator has been changed to default");
          },
        },
        "fuzzy-explorer:use-forward-slashes": {
          description: "Use forward slashes in inserted and copied paths.",
          actionScope: "list",
          didDispatch: () => {
            lumine.config.set("fuzzy-explorer.separator", 1);
            lumine.notifications.addHint("Separator has been changed to forward slash");
          },
        },
        "fuzzy-explorer:use-backslashes": {
          description: "Use backslashes in inserted and copied paths.",
          actionScope: "list",
          didDispatch: () => {
            lumine.config.set("fuzzy-explorer.separator", 2);
            lumine.notifications.addHint("Separator has been changed to backslash");
          },
        },
        "fuzzy-explorer:cut-file": {
          description: "Cut the entry to the system clipboard.",
          didDispatch: () => this.performAction("clip", { effect: "cut" }),
        },
        "fuzzy-explorer:copy-file": {
          description: "Copy the entry to the system clipboard.",
          didDispatch: () => this.performAction("clip", { effect: "copy" }),
        },
        "fuzzy-explorer:paste-into-folder": {
          description: "Paste the system clipboard into the selected directory.",
          didDispatch: () => this.performAction("paste"),
        },
        "fuzzy-explorer:query-selected-path": {
          description: "Continue the query from the selected path.",
          didDispatch: () => this.updateQueryFromItem(),
        },
        "fuzzy-explorer:remove-from-recent": {
          description: "Drop the selected entry from the recent section, leaving the list open.",
          didDispatch: () => this.removeFromRecent(),
        },
        "fuzzy-explorer:query-selection": {
          description: "Use the editor selection as the query.",
          actionScope: "list",
          didDispatch: () => this.selectList.setQueryFromSelection(),
        },
      }),
    );

    this.observeCacheUpdates();
    if (this.loadCache()) {
      this.pending = true;
    }
  },

  serialize() {
    return { recentlyUsed: this.recentlyUsed };
  },

  deactivate() {
    this.cacheUpdateSubscription.dispose();
    this.disposables.dispose();
    this.selectList.destroy();
  },

  trimRecent() {
    const oldLength = this.recentlyUsed.length;
    while (this.recentlyUsed.length > this.recentCount) this.recentlyUsed.pop();
    return this.recentlyUsed.length !== oldLength;
  },

  isRecent(itemPath) {
    return itemPath != null && this.recentlyUsed.includes(itemPath);
  },

  recordRecent(itemPath) {
    const index = this.recentlyUsed.indexOf(itemPath);
    if (index !== -1) this.recentlyUsed.splice(index, 1);
    this.recentlyUsed.unshift(itemPath);
    this.trimRecent();
    this.refreshRecent();
  },

  // Forgetting one entry is something a user does to several in a row, so the
  // list stays open and the row keeps its selection — it only moves out of
  // the section, down to where its own name puts it.
  removeFromRecent() {
    const itemPath = this.selectList.getSelectedItem();
    if (!this.isRecent(itemPath)) return;
    this.recentlyUsed.splice(this.recentlyUsed.indexOf(itemPath), 1);
    this.refreshRecent();
    if (this.selectList.items?.includes(itemPath)) this.selectList.selectItem(itemPath);
  },

  clearRecent() {
    if (this.recentlyUsed.length === 0) return;
    this.recentlyUsed.length = 0;
    this.refreshRecent();
  },

  // The list only re-reads `recentIds` when it is handed them, so mark the
  // view stale and let the next show push them through `updateView`.
  refreshRecent() {
    this.pending = true;
    if (this.selectList.isVisible()) this.updateView(true);
  },

  getConfigPath() {
    return (
      CSON.resolve(path.join(lumine.getConfigDirPath(), "explorer")) ||
      path.join(lumine.getConfigDirPath(), "explorer.json")
    );
  },

  getCachePath() {
    return path.join(this.getCacheDirectoryPath(), "explorer.json");
  },

  getCacheDirectoryPath() {
    return path.join(lumine.getConfigDirPath(), "compile-cache");
  },

  ensureCacheDirectory() {
    const cacheDir = this.getCacheDirectoryPath();
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }
    return cacheDir;
  },

  getCacheFingerprint() {
    try {
      const stat = fs.statSync(this.getCachePath());
      return `${stat.mtimeMs}:${stat.size}`;
    } catch {
      return null;
    }
  },

  observeCacheUpdates() {
    this.cacheUpdateSubscription.dispose();
    this.cacheUpdateSubscription = lumine.window.onDidReceive(
      CACHE_UPDATED_CHANNEL,
      (cacheFingerprint) => {
        this.handleCacheUpdate(cacheFingerprint);
      },
    );
  },

  handleCacheUpdate(cacheFingerprint) {
    if (this.building) return;
    if (cacheFingerprint === this.cacheFingerprint) return;
    if (this.loadCache()) {
      this.pending = true;
      this.updateView();
    }
  },

  notifyCacheUpdate() {
    void lumine.window.broadcast(CACHE_UPDATED_CHANNEL, this.cacheFingerprint).catch((error) => {
      console.error("Failed to broadcast the fuzzy-explorer cache update", error);
    });
  },

  editConfig() {
    const configPath = this.getConfigPath();
    if (!fs.existsSync(configPath)) {
      fs.writeFileSync(
        configPath,
        '[\n  // Add glob patterns here\n  // "C:/Projects/**/*.js"\n]\n',
      );
    }
    lumine.workspace.open(configPath);
  },

  loadConfig() {
    const configPath = this.getConfigPath();
    if (!fs.existsSync(configPath)) return [];
    try {
      const patterns = CSON.readFileSync(configPath);
      if (!Array.isArray(patterns)) return [];
      return patterns.filter((p) => typeof p === "string" && p.length > 0);
    } catch {
      return [];
    }
  },

  loadCache() {
    const cachePath = this.getCachePath();
    if (!fs.existsSync(cachePath)) return false;
    const cacheFingerprint = this.getCacheFingerprint();
    if (cacheFingerprint === this.cacheFingerprint) return false;
    try {
      const content = fs.readFileSync(cachePath, "utf8");
      const items = JSON.parse(content);
      if (!Array.isArray(items)) return false;
      this.items = items;
      this.cacheFingerprint = cacheFingerprint;
      return true;
    } catch {
      return false;
    }
  },

  saveCache() {
    const cachePath = this.getCachePath();
    const cacheDir = this.ensureCacheDirectory();
    const tempPath = path.join(
      cacheDir,
      `explorer-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json.tmp`,
    );

    fs.writeFileSync(tempPath, JSON.stringify(this.items));
    fs.renameSync(tempPath, cachePath);
    this.cacheFingerprint = this.getCacheFingerprint();
    this.notifyCacheUpdate();
  },

  parseIgnores() {
    this.ignores = [];
    for (let ignore of lumine.config.get("core.ignoredNames") || []) {
      this.ignores.push(ignore);
      this.ignores.push("**/" + ignore);
      this.ignores.push("**/" + ignore + "/**");
    }
    for (let ignore of lumine.config.get("fuzzy-explorer.ignoredNames") || []) {
      this.ignores.push(ignore);
      this.ignores.push("**/" + ignore);
      this.ignores.push("**/" + ignore + "/**");
    }
  },

  build() {
    if (this.building) return;
    this.building = true;
    this.parseIgnores();
    const patterns = this.loadConfig();
    const itemSet = new Set();
    if (patterns.length === 0) {
      this.items = [];
      this.saveCache();
      this.finishBuild();
      return;
    }
    Promise.all(patterns.map((pattern) => this.searchPromise(pattern, itemSet))).then(() => {
      this.items = [...itemSet];
      this.saveCache();
      this.finishBuild();
    });
  },

  finishBuild() {
    this.building = false;
    this.pending = true;
    this.updateView();
  },

  updateView(visible) {
    if (this.pending && (visible || this.selectList.isVisible())) {
      this.pending = false;
      this.selectList.update({
        items: this.items,
        recentIds: this.recentlyUsed,
        loadingMessage: null,
        infoMessage: this.infoLine(),
      });
    }
  },

  searchPromise(pattern, itemSet) {
    const search = searchForPattern(pattern);
    if (!search) return Promise.resolve();

    // The editor's crawler runs ripgrep in its own process, so there is no Task
    // to fork here: `didFindPaths` is called with batches as they arrive.
    return lumine.project.crawl({
      directoryPaths: [search.root],
      inclusion: search.include,
      ignoredNames: this.ignores,
      didFindPaths: (paths) => {
        for (const filePath of paths) {
          itemSet.add(path.normalize(filePath));
        }
      },
    });
  },

  // The command table moved to the actions list (F12); the index size is the
  // one thing only this line can say.
  infoLine() {
    const count = this.items ? this.items.length : 0;
    return `${count} files indexed`;
  },

  elementForItem(item, { highlight }) {
    return {
      primary: highlight(item),
      didRender: (li) =>
        lumine.icons.applyTo(
          li.firstChild,
          { path: item, context: "fuzzy-explorer" },
          { name: path.basename(item) },
        ),
    };
  },

  update() {
    this.selectList.update({
      items: [],
      loadingMessage: "Indexing files\u2026",
    });
    this.build();
  },

  updateQueryFromItem() {
    let text = this.selectList.getSelectedItem() + path.sep;
    this.selectList.refs.queryEditor.setText(text);
    this.selectList.refs.queryEditor.moveToEndOfLine();
  },

  performAction(mode, params) {
    const item = this.selectList.getSelectedItem();
    if (!item) return;

    let editor, itemPath, text;

    if (mode === "open") {
      itemPath = item;
      try {
        if (!fs.lstatSync(itemPath).isFile()) {
          return this.updateQueryFromItem();
        }
      } catch (error) {
        lumine.notifications.addError(error.message || String(error), {
          detail: itemPath,
        });
      }
    }

    this.selectList.hide();

    // Recency is what the user reached for, not only what they opened: every
    // action below acts on this entry, so record it once here rather than in
    // each branch, where a new action would forget to.
    this.recordRecent(item);

    if (mode === "open") {
      lumine.workspace.open(item, { pending: lumine.config.get("core.allowPendingPaneItems") });
    } else if (mode === "open-external") {
      if (this.openExternalService) {
        this.openExternalService.openExternal(item);
      } else {
        shell.openPath(item);
      }
    } else if (mode === "show-in-folder") {
      if (this.openExternalService) {
        this.openExternalService.showInFolder(item);
      } else {
        shell.showItemInFolder(item);
      }
    } else if (mode === "split") {
      itemPath = item;
      try {
        if (fs.lstatSync(itemPath).isFile()) {
          lumine.workspace.open(itemPath, { split: params.side });
        } else {
          lumine.notifications.addError("Cannot open path, because it's a dir", {
            detail: itemPath,
          });
        }
      } catch (error) {
        lumine.notifications.addError(error.message || String(error), {
          detail: itemPath,
        });
      }
    } else if (mode === "path") {
      if (params.rel === "a") {
        text = item;
      } else if (params.rel === "r") {
        editor = lumine.workspace.getActiveTextEditor();
        // No editor behind the picker is already on screen, and nothing failed.
        if (!editor) return;
        const editorPath = editor.getPath();
        text = editorPath ? path.relative(path.dirname(editorPath), item) : item;
      } else if (params.rel === "n") {
        text = path.basename(item);
      }
      if (this.separator === 1) {
        text = text.replace(/\\/g, "/");
      } else if (this.separator === 2) {
        text = text.replace(/\//g, "\\");
      }
      if (params.op === "insert") {
        if (!editor) editor = lumine.workspace.getActiveTextEditor();
        // No editor behind the picker is already on screen, and nothing failed.
        if (!editor) return;
        editor.insertText(text, { select: true });
      } else if (params.op === "copy") {
        lumine.clipboard.write(text);
      }
    } else if (mode === "clip") {
      if (!this.nativeClipService) {
        lumine.notifications.addWarning("System clipboard service not available", {
          detail: "The native-clip package is required for Cut/Copy file operations",
        });
        return;
      }
      // The service confirms with its own notification.
      if (params.effect === "cut") {
        this.nativeClipService.cutPaths([item]);
      } else if (params.effect === "copy") {
        this.nativeClipService.copyPaths([item]);
      }
    } else if (mode === "paste") {
      if (!this.nativeClipService) {
        lumine.notifications.addWarning("System clipboard service not available", {
          detail: "The native-clip package is required for Paste file operations",
        });
        return;
      }
      let dir = item;
      try {
        if (fs.lstatSync(dir).isFile()) dir = path.dirname(dir);
      } catch (error) {
        lumine.notifications.addError(error.message || String(error), {
          detail: dir,
        });
        return;
      }
      this.nativeClipService.pasteInto([dir]);
    }
  },

  consumeOpenExternal(service) {
    this.openExternalService = service;
    return new Disposable(() => {
      this.openExternalService = null;
    });
  },

  consumeNativeClip(service) {
    this.nativeClipService = service;
    return new Disposable(() => {
      this.nativeClipService = null;
    });
  },
};
