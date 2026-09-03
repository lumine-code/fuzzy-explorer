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
    this.recentCount = lumine.config.get("fuzzy-explorer.recentCount");
    this.recentlyUsed = [
      ...new Set(
        (Array.isArray(state?.recentlyUsed) ? state.recentlyUsed : []).filter(
          (aPath) => typeof aPath === "string",
        ),
      ),
    ].slice(0, this.recentCount);

    this.selectList = lumine.workspace.buildSelectList({
      className: "fuzzy-explorer",
      crumb: "Explorer",
      emptyMessage: "No matches found",
      getItemId: (item) => item,
      search: {
        getFilterText: (item) => item,
        ignoreDiacritics: true,
        algorithm: "command-t",
      },
      renderItem: (item, options) => this.renderItem(item, options),
      source: {
        mode: "snapshot",
        load: () => this.listSnapshot(),
      },
      commands: this.listCommands(),
      actions: this.listActions(),
      recents: {
        limit: this.recentCount,
        adapter: {
          load: () => this.recentlyUsed,
          save: (ids) => {
            this.recentlyUsed = [...ids];
          },
        },
      },
    });

    this.disposables = new CompositeDisposable(
      lumine.config.observe("fuzzy-explorer.separator", (value) => {
        this.separator = value;
      }),
      lumine.config.onDidChange("fuzzy-explorer.recentCount", ({ newValue }) => {
        this.recentCount = newValue;
        void this.selectList.setRecentLimit(newValue);
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
          didDispatch: () => this.selectList.clearRecentItems(),
        },
      }),
    );

    this.observeCacheUpdates();
    if (this.loadCache()) {
      this.pending = true;
    }
  },

  listCommands() {
    return {
      "fuzzy-explorer:open": {
        description: "Open the file, or continue the query into a directory.",
        didDispatch: (event) => this.performAction("open", {}, event.detail),
      },
      "fuzzy-explorer:open-external": {
        description: "Open the file in the default external program.",
        didDispatch: (event) => this.performAction("open-external", {}, event.detail),
      },
      "fuzzy-explorer:show-in-folder": {
        description: "Show the file in the system file manager.",
        didDispatch: (event) => this.performAction("show-in-folder", {}, event.detail),
      },
      "fuzzy-explorer:split-left": {
        description: "Open the file in a pane to the left.",
        didDispatch: (event) => this.performAction("split", { side: "left" }, event.detail),
      },
      "fuzzy-explorer:split-right": {
        description: "Open the file in a pane to the right.",
        didDispatch: (event) => this.performAction("split", { side: "right" }, event.detail),
      },
      "fuzzy-explorer:split-up": {
        description: "Open the file in a pane above.",
        didDispatch: (event) => this.performAction("split", { side: "up" }, event.detail),
      },
      "fuzzy-explorer:split-down": {
        description: "Open the file in a pane below.",
        didDispatch: (event) => this.performAction("split", { side: "down" }, event.detail),
      },
      "fuzzy-explorer:insert-absolute-path": {
        description: "Insert the full path from the filesystem root into the active editor.",
        didDispatch: (event) =>
          this.performAction("path", { op: "insert", rel: "a" }, event.detail),
      },
      "fuzzy-explorer:insert-relative-path": {
        description: "Insert the path relative to the active editor.",
        didDispatch: (event) =>
          this.performAction("path", { op: "insert", rel: "r" }, event.detail),
      },
      "fuzzy-explorer:insert-file-name": {
        description: "Insert the base name, without its directories, into the active editor.",
        didDispatch: (event) =>
          this.performAction("path", { op: "insert", rel: "n" }, event.detail),
      },
      "fuzzy-explorer:copy-absolute-path": {
        description: "Copy the full path from the filesystem root to the clipboard.",
        didDispatch: (event) => this.performAction("path", { op: "copy", rel: "a" }, event.detail),
      },
      "fuzzy-explorer:copy-relative-path": {
        description: "Copy the path relative to the active editor.",
        didDispatch: (event) => this.performAction("path", { op: "copy", rel: "r" }, event.detail),
      },
      "fuzzy-explorer:copy-file-name": {
        description: "Copy the base name, without its directories, to the clipboard.",
        didDispatch: (event) => this.performAction("path", { op: "copy", rel: "n" }, event.detail),
      },
      "fuzzy-explorer:refresh-index": {
        description: "Scan the configured glob patterns again and rebuild the index.",
        didDispatch: () => this.update(),
      },
      "fuzzy-explorer:use-default-separator": {
        description: "Use the platform path separator.",
        didDispatch: () => {
          lumine.config.set("fuzzy-explorer.separator", 0);
          lumine.notifications.addHint("Separator has been changed to default");
        },
      },
      "fuzzy-explorer:use-forward-slashes": {
        description: "Use forward slashes in inserted and copied paths.",
        didDispatch: () => {
          lumine.config.set("fuzzy-explorer.separator", 1);
          lumine.notifications.addHint("Separator has been changed to forward slash");
        },
      },
      "fuzzy-explorer:use-backslashes": {
        description: "Use backslashes in inserted and copied paths.",
        didDispatch: () => {
          lumine.config.set("fuzzy-explorer.separator", 2);
          lumine.notifications.addHint("Separator has been changed to backslash");
        },
      },
      "fuzzy-explorer:cut-file": {
        description: "Cut the entry to the system clipboard.",
        didDispatch: (event) => this.performAction("clip", { effect: "cut" }, event.detail),
      },
      "fuzzy-explorer:copy-file": {
        description: "Copy the entry to the system clipboard.",
        didDispatch: (event) => this.performAction("clip", { effect: "copy" }, event.detail),
      },
      "fuzzy-explorer:paste-into-folder": {
        description: "Paste the system clipboard into the selected directory.",
        didDispatch: (event) => this.performAction("paste", {}, event.detail),
      },
      "fuzzy-explorer:query-selected-path": {
        description: "Continue the query from the selected path.",
        didDispatch: (event) => this.updateQueryFromItem(event.detail.item),
      },
      "fuzzy-explorer:query-selection": {
        description: "Use the editor selection as the query.",
        didDispatch: () => this.selectList.setQueryFromSelection(),
      },
    };
  },

  listActions() {
    const itemAction = (command, group, options = {}) => ({
      command,
      context: "item",
      group,
      disposition: "close",
      recordsRecent: (_context, _action, result) => result !== false,
      ...options,
    });
    const dialogAction = (command, group, options = {}) => ({
      command,
      context: "dialog",
      group,
      disposition: "stay",
      ...options,
    });
    return [
      itemAction("fuzzy-explorer:open", "Open", {
        primary: true,
        when: ({ item }) => !this.isDirectory(item),
      }),
      itemAction("fuzzy-explorer:open-external", "Open"),
      itemAction("fuzzy-explorer:show-in-folder", "Open"),
      itemAction("fuzzy-explorer:split-left", "Split"),
      itemAction("fuzzy-explorer:split-right", "Split"),
      itemAction("fuzzy-explorer:split-up", "Split"),
      itemAction("fuzzy-explorer:split-down", "Split"),
      itemAction("fuzzy-explorer:insert-absolute-path", "Insert Path"),
      itemAction("fuzzy-explorer:insert-relative-path", "Insert Path"),
      itemAction("fuzzy-explorer:insert-file-name", "Insert Path"),
      itemAction("fuzzy-explorer:copy-absolute-path", "Copy Path"),
      itemAction("fuzzy-explorer:copy-relative-path", "Copy Path"),
      itemAction("fuzzy-explorer:copy-file-name", "Copy Path"),
      itemAction("fuzzy-explorer:cut-file", "Clipboard"),
      itemAction("fuzzy-explorer:copy-file", "Clipboard"),
      itemAction("fuzzy-explorer:paste-into-folder", "Clipboard"),
      itemAction("fuzzy-explorer:query-selected-path", "Query", {
        disposition: "stay",
        recordsRecent: false,
        primary: ({ item }) => this.isDirectory(item),
      }),
      dialogAction("fuzzy-explorer:query-selection", "Query"),
      dialogAction("fuzzy-explorer:refresh-index", "Explorer"),
      dialogAction("fuzzy-explorer:use-default-separator", "Path Separator"),
      dialogAction("fuzzy-explorer:use-forward-slashes", "Path Separator"),
      dialogAction("fuzzy-explorer:use-backslashes", "Path Separator"),
      dialogAction("fuzzy-explorer:edit", "Explorer", {
        dispatch: "workspace",
        disposition: "close",
      }),
    ];
  },

  serialize() {
    return { recentlyUsed: this.recentlyUsed };
  },

  deactivate() {
    this.cacheUpdateSubscription.dispose();
    this.disposables.dispose();
    this.selectList.destroy();
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
    return lumine.workspace.open(configPath);
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
    this.ignores = lumine.config.get("fuzzy-explorer.ignoredNames") || [];
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
      this.selectList.clearLoadingState();
      return this.selectList.update(this.listSnapshot());
    }
  },

  listSnapshot() {
    this.pending = false;
    return { items: this.items, infoMessage: this.infoLine() };
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

  // The command table moved to the actions list; the index size is the
  // one thing only this line can say.
  infoLine() {
    const count = this.items ? this.items.length : 0;
    return `${count} files indexed`;
  },

  renderItem(item, { highlight }) {
    return {
      primary: highlight(item),
      didRender: (li) => {
        lumine.icons.applyTo(
          li.firstChild,
          { path: item, context: "fuzzy-explorer" },
          { name: path.basename(item) },
        );
        const listener = (event) => this.openExternalOnAltClick(event, item);
        li.addEventListener("click", listener);
        return new Disposable(() => li.removeEventListener("click", listener));
      },
    };
  },

  openExternalOnAltClick(event, item) {
    if (event.button !== 0 || !event.altKey || !this.openExternalService) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    this.selectList.selectItem(item);
    void this.selectList.runAction("fuzzy-explorer:open-external");
  },

  update() {
    this.selectList.update({ items: [] });
    this.selectList.setLoadingState({ message: "Indexing files\u2026" });
    this.build();
  },

  updateQueryFromItem(item = this.selectList.getSelectedItem()) {
    if (!item) return false;
    const text = item + path.sep;
    this.selectList.setQuery(text);
    this.selectList.getQueryEditor().moveToEndOfLine();
    return true;
  },

  isDirectory(item) {
    if (!item) return false;
    try {
      return fs.lstatSync(item).isDirectory();
    } catch {
      return false;
    }
  },

  performAction(mode, params = {}, context = {}) {
    const item = context.item ?? this.selectList.getSelectedItem();
    if (!item) return;

    let editor, itemPath, text;

    if (mode === "open") {
      itemPath = item;
      try {
        if (!fs.lstatSync(itemPath).isFile()) {
          this.updateQueryFromItem(item);
          return false;
        }
      } catch (error) {
        lumine.notifications.addError(error.message || String(error), {
          detail: itemPath,
        });
      }
    }

    if (mode === "open") {
      return lumine.workspace.open(item, {
        pending: lumine.config.get("core.allowPendingPaneItems"),
      });
    } else if (mode === "open-external") {
      if (this.openExternalService) {
        return this.openExternalService.openExternal(item);
      } else {
        return shell.openPath(item);
      }
    } else if (mode === "show-in-folder") {
      if (this.openExternalService) {
        return this.openExternalService.showInFolder(item);
      } else {
        return shell.showItemInFolder(item);
      }
    } else if (mode === "split") {
      itemPath = item;
      try {
        if (fs.lstatSync(itemPath).isFile()) {
          return lumine.workspace.open(itemPath, { split: params.side });
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
        if (!editor) return false;
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
        if (!editor) return false;
        editor.insertText(text, { select: true });
      } else if (params.op === "copy") {
        lumine.clipboard.write(text);
      }
      return true;
    } else if (mode === "clip") {
      if (!this.nativeClipService) {
        lumine.notifications.addWarning("System clipboard service not available", {
          detail: "The native-clip package is required for Cut/Copy file operations",
        });
        return false;
      }
      // The service confirms with its own notification.
      if (params.effect === "cut") {
        return this.nativeClipService.cutPaths([item]);
      } else if (params.effect === "copy") {
        return this.nativeClipService.copyPaths([item]);
      }
    } else if (mode === "paste") {
      if (!this.nativeClipService) {
        lumine.notifications.addWarning("System clipboard service not available", {
          detail: "The native-clip package is required for Paste file operations",
        });
        return false;
      }
      let dir = item;
      try {
        if (fs.lstatSync(dir).isFile()) dir = path.dirname(dir);
      } catch (error) {
        lumine.notifications.addError(error.message || String(error), {
          detail: dir,
        });
        return false;
      }
      return this.nativeClipService.pasteInto([dir]);
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
