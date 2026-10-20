describe("fuzzy-explorer recent files", () => {
  let main, workspaceElement;

  beforeEach(async () => {
    workspaceElement = lumine.views.getView(lumine.workspace);
    jasmine.attachToDOM(workspaceElement);
    lumine.config.set("fuzzy-explorer.recentCount", 10);

    await lumine.packages.startPackage("fuzzy-explorer");
    const opening = lumine.commands.dispatch(workspaceElement, "fuzzy-explorer:toggle");
    await opening;
    main = lumine.packages.getLoadedPackage("fuzzy-explorer").mainModule;
    main.selectListHost.hide();
    await main.selectList.clearRecentItems();

    // The index is built from the user's own glob config, so the specs seed it
    // directly rather than crawling a fixture tree.
    main.items = ["/tmp/alpha.txt", "/tmp/beta.txt", "/tmp/gamma.txt"];
    main.pending = true;
  });

  afterEach(async () => {
    // The main module is a singleton across the suite, so a service stubbed
    // into it has to be taken back out.
    main.openExternalService = null;
    await lumine.packages.deactivatePackage("fuzzy-explorer");
  });

  async function showList() {
    await main.selectListHost.show();
    return main.selectList;
  }

  it("keeps the query and selected row without loading again when recent history changes", async () => {
    const list = await showList();
    list.setQuery("txt");
    await lumine.views.getNextUpdatePromise();
    const item = "/tmp/beta.txt";
    await list.selectItem(item);
    const reload = spyOn(list, "reload").and.callThrough();
    const load = spyOn(main, "listSnapshot").and.callThrough();
    const loading = spyOn(list, "setLoadingState").and.callThrough();

    await main.workspaceState.update("recentlyUsed", ["/tmp/alpha.txt"]);
    await list.recordRecentItem(item);
    await lumine.views.getNextUpdatePromise();

    expect(list.getQuery()).toBe("txt");
    expect(list.getSelectedItem()).toBe(item);
    expect(reload).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
    expect(loading).not.toHaveBeenCalled();
  });

  function nextAction() {
    return new Promise((resolve) => {
      const disposable = main.selectList.onDidFinishAction((event) => {
        disposable.dispose();
        resolve(event);
      });
    });
  }

  it("keeps the files it opened at the top, ruled off from the rest", async () => {
    spyOn(lumine.workspace, "open").and.returnValue(Promise.resolve());
    await main.selectList.recordRecentItem("/tmp/beta.txt");

    const selectList = await showList();

    expect(selectList.getDisplayedItems()[0]).toBe("/tmp/beta.txt");
    const separator = selectList.getElement().querySelector(".select-list-separator");
    expect(separator.previousElementSibling.textContent).toContain("beta.txt");
    expect(separator.nextElementSibling.textContent).not.toContain("beta.txt");
  });

  it("stands the section down under a query", async () => {
    await main.selectList.recordRecentItem("/tmp/beta.txt");
    const selectList = await showList();

    await selectList.setQuery("alpha");

    expect(selectList.getElement().querySelector(".select-list-separator")).toBeNull();
  });

  it("records a file when it is opened, most recent first", async () => {
    spyOn(lumine.workspace, "open").and.returnValue(Promise.resolve());
    const selectList = await showList();
    await selectList.selectItem("/tmp/alpha.txt");
    // performAction stats the path before opening it; a miss is reported and
    // the open still runs, which is the path under test here.
    await selectList.runAction("fuzzy-explorer:open");

    expect(main.recentlyUsed[0]).toBe("/tmp/alpha.txt");
    expect(main.workspaceState.get("recentlyUsed", [])).toEqual(main.recentlyUsed);
  });

  it("records the entry for every action over it, not only an open", async () => {
    main.openExternalService = {
      openExternal: jasmine.createSpy("openExternal"),
      showInFolder: jasmine.createSpy("showInFolder"),
    };
    const selectList = await showList();
    await selectList.selectItem("/tmp/alpha.txt");
    spyOn(lumine.clipboard, "write");

    await selectList.runAction("fuzzy-explorer:open-external");
    expect(main.openExternalService.openExternal).toHaveBeenCalledWith("/tmp/alpha.txt");
    expect(main.recentlyUsed).toEqual(["/tmp/alpha.txt"]);

    await showList();
    await selectList.selectItem("/tmp/alpha.txt");
    await selectList.runAction("fuzzy-explorer:copy-absolute-path");
    expect(lumine.clipboard.write).toHaveBeenCalledWith("/tmp/alpha.txt");
    expect(main.recentlyUsed).toEqual(["/tmp/alpha.txt"]);
  });

  it("opens a Ctrl-Alt-clicked entry externally without also opening it in the editor", async () => {
    const open = spyOn(lumine.workspace, "open").and.returnValue(Promise.resolve());
    main.openExternalService = { openExternal: jasmine.createSpy("openExternal") };
    const selectList = await showList();
    await selectList.selectItem("/tmp/alpha.txt");
    const index = selectList.getDisplayedItems().indexOf("/tmp/gamma.txt");
    const row = selectList.getElement().querySelectorAll("li[role='option']")[index];

    const action = nextAction();
    row.dispatchEvent(
      new MouseEvent("click", {
        altKey: true,
        ctrlKey: true,
        button: 0,
        bubbles: true,
        cancelable: true,
      }),
    );
    await action;

    expect(main.openExternalService.openExternal).toHaveBeenCalledWith("/tmp/gamma.txt");
    expect(open).not.toHaveBeenCalled();
    expect(main.recentlyUsed).toEqual(["/tmp/gamma.txt"]);
  });

  it("opens the chooser for the Alt-clicked entry even without an external service", async () => {
    const open = spyOn(lumine.workspace, "open").and.returnValue(Promise.resolve());
    const choose = jasmine.createSpy("choose opener");
    const command = lumine.commands.add("lumine-workspace", "launcher:open", choose);
    const selectList = await showList();
    const index = selectList.getDisplayedItems().indexOf("/tmp/gamma.txt");
    const row = selectList.getElement().querySelectorAll("li[role='option']")[index];

    const action = nextAction();
    row.dispatchEvent(
      new MouseEvent("click", { altKey: true, button: 0, bubbles: true, cancelable: true }),
    );
    const result = await action;
    command.dispose();

    expect(result.command).toBe("fuzzy-explorer:choose-opener");
    expect(choose).toHaveBeenCalledTimes(1);
    expect(choose.calls.mostRecent().args[0].detail.path).toBe("/tmp/gamma.txt");
    expect(open).not.toHaveBeenCalled();
    expect(main.recentlyUsed).toEqual([]);
  });

  it("records nothing for a directory it only continued the query into", async () => {
    // A directory the query walks into is not an entry the user acted on, and
    // recording one would fill the section with the path to every file opened.
    await main.selectList.update({ items: [__dirname] });

    await main.selectList.runAction("fuzzy-explorer:query-selected-path");

    expect(main.recentlyUsed).toEqual([]);
    expect(main.selectList.getQueryEditor().getText()).toBe(__dirname + require("path").sep);
  });

  it("drops one entry from the section without closing the list", async () => {
    await main.selectList.recordRecentItem("/tmp/gamma.txt");
    await main.selectList.recordRecentItem("/tmp/beta.txt");
    const selectList = await showList();
    await selectList.selectItem("/tmp/beta.txt");

    await selectList.runAction("select-list:remove-recent");
    await lumine.views.getNextUpdatePromise();

    expect(main.recentlyUsed).toEqual(["/tmp/gamma.txt"]);
    expect(main.selectListHost.isVisible()).toBe(true);
    // The row is still the selected one, at the place its own name puts it.
    expect(selectList.getSelectedItem()).toBe("/tmp/beta.txt");
    expect(selectList.getDisplayedItems()[0]).toBe("/tmp/gamma.txt");
  });

  it("stays open when the core recent action is run", async () => {
    await main.selectList.recordRecentItem("/tmp/gamma.txt");
    await main.selectList.recordRecentItem("/tmp/beta.txt");
    const selectList = await showList();
    await selectList.selectItem("/tmp/beta.txt");

    await selectList.runAction("select-list:remove-recent");

    expect(main.recentlyUsed).toEqual(["/tmp/gamma.txt"]);
    expect(main.selectListHost.isVisible()).toBe(true);
    expect(selectList.getSelectedItem()).toBe("/tmp/beta.txt");
  });

  it("offers the action only while a recent entry is selected", async () => {
    await main.selectList.recordRecentItem("/tmp/beta.txt");
    const selectList = await showList();

    await selectList.selectItem("/tmp/beta.txt");
    let actions = selectList.getAvailableActions().map((action) => action.command);
    expect(actions).toContain("select-list:remove-recent");

    await selectList.selectItem("/tmp/alpha.txt");
    actions = selectList.getAvailableActions().map((action) => action.command);
    expect(actions).not.toContain("select-list:remove-recent");
    // The rest of the package's actions are unaffected by the filter.
    expect(actions).toContain("fuzzy-explorer:open-external");
  });

  it("caps the list at the configured count", async () => {
    lumine.config.set("fuzzy-explorer.recentCount", 2);
    await main.selectList.recordRecentItem("/tmp/alpha.txt");
    await main.selectList.recordRecentItem("/tmp/beta.txt");
    await main.selectList.recordRecentItem("/tmp/gamma.txt");

    expect(main.recentlyUsed).toEqual(["/tmp/gamma.txt", "/tmp/beta.txt"]);
  });

  it("forgets everything on clear-recent", async () => {
    await main.selectList.recordRecentItem("/tmp/beta.txt");
    const selectList = await showList();

    await lumine.commands.dispatch(workspaceElement, "fuzzy-explorer:clear-recent");
    await lumine.views.getNextUpdatePromise();

    expect(main.recentlyUsed).toEqual([]);
    expect(selectList.getElement().querySelector(".select-list-separator")).toBeNull();
  });

  it("loads persisted project recents after package reactivation", async () => {
    await main.selectList.recordRecentItem("/tmp/beta.txt");
    expect(main.workspaceState.get("recentlyUsed", [])).toEqual(["/tmp/beta.txt"]);

    // Project storage outlives the package generation; dispatching a command
    // constructs the next generation's lazy list from the stored value.
    await lumine.packages.deactivatePackage("fuzzy-explorer");
    await lumine.packages.startPackage("fuzzy-explorer");
    await lumine.commands.dispatch(workspaceElement, "fuzzy-explorer:toggle");
    const pack = lumine.packages.getLoadedPackage("fuzzy-explorer");
    pack.mainModule.selectListHost.hide();

    expect(pack.mainModule.recentlyUsed).toEqual(["/tmp/beta.txt"]);
  });
  it("projects stored history changes into the existing list and persists the next use", async () => {
    const list = main.selectList;
    const restored = "/tmp/beta.txt";
    await main.workspaceState.update("recentlyUsed", [restored]);
    expect(main.selectList).toBe(list);
    expect(list.getRecentItemIds()).toEqual([restored]);
    await list.recordRecentItem("/tmp/alpha.txt");
    expect(main.workspaceState.get("recentlyUsed", [])).toEqual([
      list.getItemId("/tmp/alpha.txt"),
      restored,
    ]);
  });
  it("keeps concurrent records from two window lists and honours removal and clear", async () => {
    const extra = await lumine.workspace.openEditorWindow({ show: false });
    try {
      const local = main.selectList;
      const remote = main.ensureSelectList(extra).getModel();
      const first = "/tmp/alpha.txt";
      const second = "/tmp/beta.txt";
      const ids = [local.getItemId(second), local.getItemId(first)];
      await Promise.all([local.recordRecentItem(first), remote.recordRecentItem(second)]);
      expect(main.workspaceState.get("recentlyUsed")).toEqual(ids);
      expect(local.getRecentItemIds()).toEqual(ids);
      expect(remote.getRecentItemIds()).toEqual(ids);
      await local.removeRecentItem(ids[1]);
      expect(main.workspaceState.get("recentlyUsed")).toEqual([ids[0]]);
      await remote.clearRecentItems();
      expect(main.workspaceState.get("recentlyUsed")).toEqual([]);
    } finally {
      await lumine.workspace.closeEditorWindow(extra);
    }
  });
});
