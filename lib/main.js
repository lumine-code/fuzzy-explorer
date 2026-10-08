const { CompositeDisposable, Disposable, watchDirectory } = require("lumine");
const path = require("path");
const fs = require("fs");

const CACHE_UPDATED_CHANNEL = "fuzzy-explorer:cache-updated";
let shell;
let CSON;
let searchForPattern;

function getShell() {
  return (shell ||= require("electron").shell);
}

function getCSON() {
  return (CSON ||= require("@lumine-code/season"));
}

function getSearchForPattern() {
  return (searchForPattern ||= require("./search-pattern"));
}

module.exports = {
  provideBackgroundTips() {
    return {
      packageName: "fuzzy-explorer",
      tips: [
        "You can search files across your own list of directories with {{ 'fuzzy-explorer:toggle' | keystroke }}",
      ],
    };
  },

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
  selectListHost: null,

  ensureSelectList() {
    if (this.selectListHost) return this.selectListHost;

    const selectListOptions = {
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
    };

    this.selectListHost = lumine.workspace.addSelectList(selectListOptions, {
      className: "fuzzy-explorer",
      crumb: "Explorer",
    });
    this.selectList = this.selectListHost.getModel();
    this.loadCache();
    if (this.pending) this.updateView();
    return this.selectListHost;
  },

  activate(state) {
    this.buildRequest = null;
    this.building = false;
    this.indexRevision = 0;
    this.configWatcher = null;
    this.items = [];
    this.cacheFingerprint = null;
    this.cacheUpdateSubscription = new Disposable();
    this.recentCount = lumine.config.get("fuzzy-explorer.recentCount");
    this.recentlyUsed = [
      ...new Set(
        (Array.isArray(state?.recentlyUsed) ? state.recentlyUsed : []).filter(
          (aPath) => typeof aPath === "string",
        ),
      ),
    ].slice(0, this.recentCount);

    const owner = new CompositeDisposable();
    this.disposables = owner;
    owner.add(
      lumine.config.observe("fuzzy-explorer.separator", (value) => {
        if (this.isIndexOwner(owner)) this.separator = value;
      }),
      lumine.config.onDidChange("fuzzy-explorer.recentCount", ({ newValue }) => {
        if (!this.isIndexOwner(owner)) return;
        this.recentCount = newValue;
        if (this.selectList) void this.selectList.setRecentLimit(newValue);
      }),
      lumine.config.onDidChangeConfiguration((event) => {
        if (!this.isIndexOwner(owner)) return;
        if (
          [
            "fuzzy-explorer.ignoredNames",
            "core.ignoredNames",
            "core.followSymlinks",
            "core.excludeVcsIgnoredPaths",
          ].some((key) => event.affectsConfiguration(key))
        ) {
          this.indexRevision++;
          this.retireBuild(this.buildRequest);
        }
      }),
      lumine.commands.add("lumine-workspace", {
        "fuzzy-explorer:toggle": () => this.ensureSelectList().toggle(),
        "fuzzy-explorer:edit": {
          description: "Open the configuration that decides what the list offers.",
          didDispatch: () => this.editConfig(),
        },
        "fuzzy-explorer:clear-recent": {
          description: "Forget the recently used entries kept at the top of the list.",
          didDispatch: () => this.ensureSelectList().getModel().clearRecentItems(),
        },
      }),
    );

    this.observeCacheUpdates();
    // The cache is read when the list is first shown. This keeps activation
    // free of synchronous disk I/O for users who never open the explorer.
    this.pending = true;
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
        didDispatch: () => this.ensureSelectList().getModel().setQueryFromSelection(),
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
    const owner = this.disposables;
    const cacheUpdates = this.cacheUpdateSubscription;
    const host = this.selectListHost;
    this.cacheUpdateSubscription = null;
    this.disposables = null;
    this.selectListHost = null;
    this.selectList = null;
    this.configWatcher = null;
    this.retireBuild(this.buildRequest);
    cacheUpdates?.dispose();
    owner?.dispose();
    host?.destroy();
  },

  getConfigPath() {
    return (
      getCSON().resolve(path.join(lumine.getConfigDirPath(), "explorer")) ||
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
    const owner = this.disposables;
    this.cacheUpdateSubscription?.dispose();
    if (!this.isIndexOwner(owner)) return;
    this.cacheUpdateSubscription = lumine.window.onDidReceive(
      CACHE_UPDATED_CHANNEL,
      (cacheFingerprint) => {
        if (this.isIndexOwner(owner)) this.handleCacheUpdate(cacheFingerprint);
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
    const owner = this.disposables;
    const fingerprint = this.cacheFingerprint;
    if (!this.isIndexOwner(owner)) return;
    void lumine.window.broadcast(CACHE_UPDATED_CHANNEL, fingerprint).catch((error) => {
      if (this.isIndexOwner(owner) && this.cacheFingerprint === fingerprint) {
        console.error("Failed to broadcast the fuzzy-explorer cache update", error);
      }
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
      const patterns = getCSON().readFileSync(configPath);
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

  saveCache(items = this.items, { notify = true } = {}) {
    const cachePath = this.getCachePath();
    const cacheDir = this.ensureCacheDirectory();
    const tempPath = path.join(
      cacheDir,
      `explorer-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json.tmp`,
    );

    try {
      fs.writeFileSync(tempPath, JSON.stringify(items));
      fs.renameSync(tempPath, cachePath);
    } finally {
      fs.rmSync(tempPath, { force: true });
    }
    this.cacheFingerprint = this.getCacheFingerprint();
    if (notify) this.notifyCacheUpdate();
  },

  parseIgnores() {
    this.ignores = lumine.config.get("fuzzy-explorer.ignoredNames") || [];
  },

  build() {
    const owner = this.disposables;
    if (!this.isIndexOwner(owner)) return;
    this.retireBuild(this.buildRequest);
    if (!this.isIndexOwner(owner)) return;
    this.ensureIndexConfigWatcher();
    if (!this.isIndexOwner(owner)) return;
    const configuration = this.indexConfiguration();
    if (!this.isIndexOwner(owner)) return;
    const request = {
      owner,
      revision: this.indexRevision,
      configuration,
      signature: JSON.stringify(configuration),
      crawls: new Set(),
      retired: false,
    };
    this.buildRequest = request;
    this.building = true;
    request.promise = this.runIndexBuild(request);
  },

  async runIndexBuild(request) {
    const itemSet = new Set();
    try {
      await Promise.all(
        request.configuration.patterns.map((pattern) =>
          this.searchPromise(pattern, itemSet, request),
        ),
      );
      if (!this.isCurrentBuild(request, true)) return;
      const items = [...itemSet];
      this.saveCache(items, { notify: false });
      if (!this.isCurrentBuild(request)) return;
      this.items = items;
      this.notifyCacheUpdate();
      if (!this.isCurrentBuild(request)) return;
      await this.finishBuild();
    } catch (error) {
      if (this.isCurrentBuild(request, true)) {
        lumine.notifications.addError("Unable to index explorer files.", {
          detail: error.message ?? String(error),
          dismissable: true,
        });
      }
    } finally {
      for (const crawl of request.crawls) crawl.cancel?.();
      request.crawls.clear();
      if (this.buildRequest === request) {
        this.buildRequest = null;
        this.building = false;
        if (this.isIndexOwner(request.owner)) this.selectList?.clearLoadingState();
      }
    }
  },

  isIndexOwner(owner) {
    return !!owner && this.disposables === owner && !owner.disposed;
  },

  indexConfiguration() {
    return {
      configPath: this.getConfigPath(),
      patterns: this.loadConfig(),
      ignoredNames: [...(lumine.config.get("fuzzy-explorer.ignoredNames") || [])],
      coreIgnoredNames: [...(lumine.config.get("core.ignoredNames") || [])],
      followSymlinks: lumine.config.get("core.followSymlinks"),
      excludeVcsIgnoredPaths: lumine.config.get("core.excludeVcsIgnoredPaths"),
    };
  },

  isCurrentBuild(request, checkConfiguration = false) {
    return (
      !request.retired &&
      this.isIndexOwner(request.owner) &&
      this.buildRequest === request &&
      this.indexRevision === request.revision &&
      (!checkConfiguration || JSON.stringify(this.indexConfiguration()) === request.signature)
    );
  },

  retireBuild(request) {
    if (!request || request.retired) return;
    request.retired = true;
    for (const crawl of request.crawls) crawl.cancel?.();
    request.crawls.clear();
    if (this.buildRequest === request) {
      this.buildRequest = null;
      this.building = false;
      if (this.isIndexOwner(request.owner)) this.selectList?.clearLoadingState();
    }
  },

  ensureIndexConfigWatcher() {
    if (this.configWatcher) return;
    const owner = this.disposables;
    const watcher = watchDirectory(lumine.getConfigDirPath());
    this.configWatcher = watcher;
    const changed = () => {
      const request = this.buildRequest;
      if (
        this.isIndexOwner(owner) &&
        request &&
        JSON.stringify(this.indexConfiguration()) !== request.signature
      ) {
        this.indexRevision++;
        this.retireBuild(request);
      }
    };
    const failed = (error) => {
      if (this.isIndexOwner(owner))
        console.error("Unable to observe explorer configuration", error);
    };
    owner.add(
      watcher,
      watcher.onDidChange((events) => {
        if (
          events.some((event) => /^explorer\.(?:cson|json|jsonc)$/i.test(path.basename(event.path)))
        )
          changed();
      }),
      watcher.onDidInvalidate(changed),
      watcher.onDidError(failed),
    );
    watcher.ready.catch(failed);
  },

  finishBuild() {
    this.building = false;
    this.pending = true;
    return this.updateView();
  },

  updateView(visible) {
    if (this.selectList && this.pending && (visible || this.selectListHost?.isVisible())) {
      this.pending = false;
      this.selectList.clearLoadingState();
      return this.selectList.update(this.listSnapshot());
    }
  },

  listSnapshot() {
    this.pending = false;
    return { items: this.items, infoMessage: this.infoLine() };
  },

  searchPromise(pattern, itemSet, request) {
    if (request && !this.isCurrentBuild(request)) return Promise.resolve();
    const search = getSearchForPattern()(pattern);
    if (!search) return Promise.resolve();

    // The editor's crawler runs ripgrep in its own process, so there is no Task
    // to fork here: `didFindPaths` is called with batches as they arrive.
    const snapshot = request?.configuration;
    const crawl = lumine.project.crawl({
      directoryPaths: [search.root],
      inclusion: search.include,
      ignoredNames: snapshot
        ? [...snapshot.ignoredNames, ...snapshot.coreIgnoredNames]
        : this.ignores,
      ...(snapshot
        ? {
            useCoreIgnoredNames: false,
            followSymlinks: snapshot.followSymlinks,
            excludeVcsIgnoredPaths: snapshot.excludeVcsIgnoredPaths,
          }
        : {}),
      didFindPaths: (paths) => {
        if (request && !this.isCurrentBuild(request)) return;
        for (const filePath of paths) {
          itemSet.add(path.normalize(filePath));
        }
      },
    });
    if (!request) return crawl;
    request.crawls.add(crawl);
    if (!this.isCurrentBuild(request)) {
      crawl.cancel?.();
      request.crawls.delete(crawl);
    }
    return Promise.resolve(crawl).finally(() => request.crawls.delete(crawl));
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
    if (!this.isIndexOwner(this.disposables)) return;
    this.retireBuild(this.buildRequest);
    this.ensureSelectList();
    this.selectList.update({ items: [] });
    this.selectList.setLoadingState({ message: "Indexing files\u2026" });
    this.build();
  },

  updateQueryFromItem(item) {
    const selectList = this.selectList || this.ensureSelectList().getModel();
    if (item == null) item = selectList.getSelectedItem();
    if (!item) return false;
    const text = item + path.sep;
    selectList.setQuery(text);
    selectList.getQueryEditor().moveToEndOfLine();
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

  async performAction(mode, params = {}, context = {}) {
    const item = context.item ?? this.selectList?.getSelectedItem();
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
        return getShell().openPath(item);
      }
    } else if (mode === "show-in-folder") {
      if (this.openExternalService) {
        return this.openExternalService.showInFolder(item);
      } else {
        return getShell().showItemInFolder(item);
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
        await lumine.packages.requestService("native-clip", "^1.0.0");
      }
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
        await lumine.packages.requestService("native-clip", "^1.0.0");
      }
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
