const {
  CompositeDisposable,
  Disposable,
  Emitter,
  watchDirectory,
  updateRecentItemIds,
} = require("lumine");
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

  ensureSelectList(window = lumine.workspace.getMainWindow()) {
    const existing = this.windowLists.get(window);
    if (existing) return existing.host;

    const selectListOptions = {
      emptyMessage: "No matches found",
      getItemId: (item) => item,
      search: {
        getFilterText: (item) => item,
        ignoreDiacritics: true,
        prepareOnIdle: true,
        algorithm: "command-t",
      },
      renderItem: (item, options) => this.renderItem(item, options),
      source: {
        mode: "snapshot",
        load: () => this.listSnapshot(),
      },
      commands: this.listCommands(window),
      actions: this.listActions(),
      recents: {
        limit: this.recentCount,
        adapter: {
          serializesWrites: true,
          load: () => this.recentlyUsed,
          save: (ids, change) =>
            this.workspaceState.mutate("recentlyUsed", (current) =>
              updateRecentItemIds(normalizeRecentIds(current), ids, change),
            ),
          onDidChange: (callback) => this.recentEvents.on("did-change", callback),
        },
      },
    };

    const host = lumine.workspace.addSelectList(selectListOptions, {
      window,
      className: "fuzzy-explorer",
      crumb: "Explorer",
    });
    const model = host.getModel();
    const subscriptions = new CompositeDisposable();
    const record = { window, host, model, subscriptions, opening: null };
    subscriptions.add(
      model.onDidChangeSelection(({ item }) => this.refreshPathKind(item, record)),
      host.onDidOpen(() => {
        record.opening = {
          pane: window.getEditorContainer().getActivePane(),
          editor: window.getEditorContainer().getActiveEmbeddedTextEditor(),
        };
        lumine.commands.invalidateAvailability({ target: model.getElement() });
        this.refreshPathKind(model.getSelectedItem(), record);
      }),
      window.onWillDestroy(() => {
        this.windowLists.delete(window);
        subscriptions.dispose();
        void host.destroy();
      }),
    );
    this.windowLists.set(window, record);
    if (window.isMain()) {
      this.selectListHost = host;
      this.selectList = model;
    }
    this.loadCache();
    if (this.pending) this.updateView();
    return host;
  },

  activate(context) {
    this.workspaceState = context.workspaceState;
    this.windowLists = new Map();
    this.pathKinds = new Map();
    this.pathKindRequests = new Map();
    this.recentEvents = new Emitter();
    this.serviceEdges = new Map();
    this.openExternalService = this.nativeClipService = null;
    this.buildRequest = null;
    this.building = false;
    this.indexRevision = 0;
    this.configWatcher = null;
    this.items = [];
    this.cacheFingerprint = null;
    this.cacheUpdateSubscription = new Disposable();
    this.recentCount = lumine.config.get("fuzzy-explorer.recentCount");
    this.recentlyUsed = normalizeRecentIds(this.workspaceState.get("recentlyUsed", [])).slice(
      0,
      this.recentCount,
    );

    const owner = new CompositeDisposable();
    this.disposables = owner;
    owner.add(
      this.workspaceState.observe("recentlyUsed", (ids) => {
        this.recentlyUsed = normalizeRecentIds(ids).slice(0, this.recentCount);
        this.recentEvents.emit("did-change", this.recentlyUsed);
      }),
      lumine.config.observe("fuzzy-explorer.separator", (value) => {
        if (this.isIndexOwner(owner)) this.separator = value;
      }),
      lumine.config.onDidChange("fuzzy-explorer.recentCount", ({ newValue }) => {
        if (!this.isIndexOwner(owner)) return;
        this.recentCount = newValue;
        for (const record of this.windowLists.values())
          void record.model.setRecentLimit(newValue).catch(reportStorageError);
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
        "fuzzy-explorer:toggle": (event) => this.ensureSelectList(event.context?.window).toggle(),
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

  hasCapturedEditor(window, writable = false) {
    const editor = this.windowLists.get(window)?.opening?.editor;
    return Boolean(editor && !editor.isDestroyed() && (!writable || !editor.isReadOnly()));
  },

  listCommands(window = lumine.workspace.getMainWindow()) {
    return {
      "fuzzy-explorer:open": {
        description: "Open the file, or continue the query into a directory.",
        didDispatch: (event) => this.performAction("open", {}, { ...event.detail, window }),
      },
      "fuzzy-explorer:choose-opener": {
        description: "Choose how and where to open the selected file or folder.",
        didDispatch: (event) =>
          this.performAction("choose-opener", {}, { ...event.detail, window }),
      },
      "fuzzy-explorer:open-external": {
        description: "Open the file in the default external program.",
        didDispatch: (event) =>
          this.performAction("open-external", {}, { ...event.detail, window }),
      },
      "fuzzy-explorer:show-in-folder": {
        description: "Show the file in the system file manager.",
        didDispatch: (event) =>
          this.performAction("show-in-folder", {}, { ...event.detail, window }),
      },
      "fuzzy-explorer:split-left": {
        description: "Open the file in a pane to the left.",
        didDispatch: (event) =>
          this.performAction("split", { side: "left" }, { ...event.detail, window }),
      },
      "fuzzy-explorer:split-right": {
        description: "Open the file in a pane to the right.",
        didDispatch: (event) =>
          this.performAction("split", { side: "right" }, { ...event.detail, window }),
      },
      "fuzzy-explorer:split-up": {
        description: "Open the file in a pane above.",
        didDispatch: (event) =>
          this.performAction("split", { side: "up" }, { ...event.detail, window }),
      },
      "fuzzy-explorer:split-down": {
        description: "Open the file in a pane below.",
        didDispatch: (event) =>
          this.performAction("split", { side: "down" }, { ...event.detail, window }),
      },
      "fuzzy-explorer:insert-absolute-path": {
        isAvailable: () => this.hasCapturedEditor(window, true),
        description: "Insert the full path from the filesystem root into the active editor.",
        didDispatch: (event) =>
          this.performAction("path", { op: "insert", rel: "a" }, { ...event.detail, window }),
      },
      "fuzzy-explorer:insert-relative-path": {
        isAvailable: () => this.hasCapturedEditor(window, true),
        description: "Insert the path relative to the active editor.",
        didDispatch: (event) =>
          this.performAction("path", { op: "insert", rel: "r" }, { ...event.detail, window }),
      },
      "fuzzy-explorer:insert-file-name": {
        isAvailable: () => this.hasCapturedEditor(window, true),
        description: "Insert the base name, without its directories, into the active editor.",
        didDispatch: (event) =>
          this.performAction("path", { op: "insert", rel: "n" }, { ...event.detail, window }),
      },
      "fuzzy-explorer:copy-absolute-path": {
        description: "Copy the full path from the filesystem root to the clipboard.",
        didDispatch: (event) =>
          this.performAction("path", { op: "copy", rel: "a" }, { ...event.detail, window }),
      },
      "fuzzy-explorer:copy-relative-path": {
        isAvailable: () => this.hasCapturedEditor(window),
        description: "Copy the path relative to the active editor.",
        didDispatch: (event) =>
          this.performAction("path", { op: "copy", rel: "r" }, { ...event.detail, window }),
      },
      "fuzzy-explorer:copy-file-name": {
        description: "Copy the base name, without its directories, to the clipboard.",
        didDispatch: (event) =>
          this.performAction("path", { op: "copy", rel: "n" }, { ...event.detail, window }),
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
        didDispatch: (event) =>
          this.performAction("clip", { effect: "cut" }, { ...event.detail, window }),
      },
      "fuzzy-explorer:copy-file": {
        description: "Copy the entry to the system clipboard.",
        didDispatch: (event) =>
          this.performAction("clip", { effect: "copy" }, { ...event.detail, window }),
      },
      "fuzzy-explorer:paste-into-folder": {
        description: "Paste the system clipboard into the selected directory.",
        didDispatch: (event) => this.performAction("paste", {}, { ...event.detail, window }),
      },
      "fuzzy-explorer:query-selected-path": {
        description: "Continue the query from the selected path.",
        didDispatch: (event) => this.updateQueryFromItem(event.detail.item, window),
      },
      "fuzzy-explorer:query-selection": {
        description: "Use the editor selection as the query.",
        didDispatch: () => this.ensureSelectList(window).getModel().setQueryFromSelection(),
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
      itemAction("fuzzy-explorer:choose-opener", "Open", {
        disposition: "push",
        recordsRecent: false,
      }),
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

  async deactivate() {
    const owner = this.disposables;
    const cacheUpdates = this.cacheUpdateSubscription;
    const records = [...(this.windowLists?.values() ?? [])];
    this.windowLists?.clear();
    for (const record of records) record.subscriptions.dispose();
    this.recentEvents?.dispose();
    this.cacheUpdateSubscription = null;
    this.disposables = null;
    this.serviceEdges = null;
    this.openExternalService = this.nativeClipService = null;
    this.selectListHost = null;
    this.selectList = null;
    this.configWatcher = null;
    this.retireBuild(this.buildRequest);
    cacheUpdates?.dispose();
    owner?.dispose();
    await Promise.all(records.map((record) => record.host.destroy()));
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
      this.pathKinds.clear();
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
      this.pathKinds.clear();
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
        if (this.isIndexOwner(request.owner)) this.clearLoadingState();
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
      if (this.isIndexOwner(request.owner)) this.clearLoadingState();
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
    if (!this.pending) return;
    for (const record of this.windowLists.values())
      if (visible || record.host.isVisible()) {
        record.model.clearLoadingState();
        void record.model.update({ items: this.items, infoMessage: this.infoLine() });
      }
    this.pending = false;
  },

  listSnapshot() {
    // Immutable index snapshots retain SelectList records across reopenings.
    this.items = Object.freeze(this.items);
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
        return lumine.icons.applyTo(
          li.firstChild,
          { path: item, context: "fuzzy-explorer" },
          { name: path.basename(item) },
        );
      },
    };
  },

  clearLoadingState() {
    for (const record of this.windowLists.values()) record.model.clearLoadingState();
  },

  update() {
    if (!this.isIndexOwner(this.disposables)) return;
    this.retireBuild(this.buildRequest);
    this.ensureSelectList();
    for (const record of this.windowLists.values()) {
      record.model.update({ items: [] });
      record.model.setLoadingState({ message: "Indexing files\u2026" });
    }
    this.build();
  },

  updateQueryFromItem(item, window) {
    const selectList = this.ensureSelectList(window).getModel();
    if (item == null) item = selectList.getSelectedItem();
    if (!item) return false;
    const text = item + path.sep;
    selectList.setQuery(text);
    selectList.getQueryEditor().moveToEndOfLine();
    return true;
  },

  isDirectory(item) {
    return this.pathKinds?.get(item) === true;
  },

  refreshPathKind(item) {
    if (!item || this.pathKindRequests.has(item)) return;
    const owner = this.disposables,
      requests = this.pathKindRequests;
    const request = {};
    requests.set(item, request);
    void fs.promises
      .lstat(item)
      .then(
        (stat) => stat.isDirectory(),
        () => false,
      )
      .then((directory) => {
        if (this.disposables !== owner || owner.disposed) return;
        if (this.pathKinds.get(item) === directory) return;
        this.pathKinds.set(item, directory);
        for (const current of this.windowLists.values()) {
          if (!current.host?.isVisible() || current.model.getSelectedItem() !== item) continue;
          void current.model.update({});
          lumine.commands.invalidateAvailability({ target: current.model.getElement() });
        }
      })
      .finally(() => {
        if (requests.get(item) === request) requests.delete(item);
      });
  },

  async performAction(mode, params = {}, context = {}) {
    const window = context.window ?? lumine.workspace.getMainWindow();
    const record = this.windowLists.get(window);
    const target = record?.opening ?? {
      pane: window.getEditorContainer().getActivePane(),
      editor: window.getEditorContainer().getActiveEmbeddedTextEditor(),
    };
    const item = context.item ?? record?.model.getSelectedItem();
    if (!item) return;

    let editor, itemPath, text;

    if (mode === "choose-opener") {
      const opening = lumine.commands.dispatch(window.getElement(), "launcher:open", {
        path: item,
        pane: target.pane,
      });
      if (!opening) throw new Error("The Launcher package is not available.");
      return opening;
    }

    if (mode === "open") {
      itemPath = item;
      try {
        if (!fs.statSync(itemPath).isFile()) {
          this.updateQueryFromItem(item, window);
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
        pane: target.pane,
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
        if (fs.statSync(itemPath).isFile()) {
          return lumine.workspace.open(itemPath, { pane: target.pane, split: params.side });
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
        editor = target.editor;
        // No editor behind the picker is already on screen, and nothing failed.
        if (!editor || editor.isDestroyed()) return false;
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
        if (!editor) editor = target.editor;
        // No editor behind the picker is already on screen, and nothing failed.
        if (!editor || editor.isDestroyed()) return false;
        if (editor.isReadOnly()) return false;
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
    return this.consumeService("openExternalService", service);
  },

  consumeNativeClip(service) {
    return this.consumeService("nativeClipService", service);
  },

  consumeService(field, service) {
    const owner = this.disposables;
    const edges = this.serviceEdges;
    if (!this.isIndexOwner(owner) || !edges) return new Disposable();
    let providers = edges.get(field);
    if (!providers) edges.set(field, (providers = []));
    const edge = { service };
    providers.push(edge);
    this[field] = service;
    return new Disposable(() => {
      const index = providers.indexOf(edge);
      if (index < 0) return;
      providers.splice(index, 1);
      if (this.disposables === owner && this.serviceEdges === edges)
        this[field] = providers.at(-1)?.service ?? null;
    });
  },
};

function normalizeRecentIds(ids) {
  return [...new Set((Array.isArray(ids) ? ids : []).filter((id) => typeof id === "string"))];
}

function reportStorageError(error) {
  lumine.notifications.addError("Unable to save recent items", {
    detail: error.message,
    dismissable: true,
  });
}
