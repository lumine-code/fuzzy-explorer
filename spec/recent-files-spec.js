describe("fuzzy-explorer recent files", () => {
  let main, workspaceElement;

  beforeEach(async () => {
    workspaceElement = lumine.views.getView(lumine.workspace);
    jasmine.attachToDOM(workspaceElement);
    lumine.config.set("fuzzy-explorer.recentCount", 10);

    const activation = lumine.packages.activatePackage("fuzzy-explorer");
    lumine.commands.dispatch(workspaceElement, "fuzzy-explorer:toggle");
    main = (await activation).mainModule;
    main.selectList.hide();
    main.clearRecent();

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
    main.selectList.show();
    await lumine.views.getNextUpdatePromise();
    return main.selectList;
  }

  it("keeps the files it opened at the top, ruled off from the rest", async () => {
    spyOn(lumine.workspace, "open").and.returnValue(Promise.resolve());
    main.recordRecent("/tmp/beta.txt");

    const selectList = await showList();

    expect(selectList.items[0]).toBe("/tmp/beta.txt");
    const separator = selectList.element.querySelector(".select-list-separator");
    expect(separator.previousElementSibling.textContent).toContain("beta.txt");
    expect(separator.nextElementSibling.textContent).not.toContain("beta.txt");
  });

  it("stands the section down under a query", async () => {
    main.recordRecent("/tmp/beta.txt");
    const selectList = await showList();

    selectList.getQueryEditor().setText("alpha");
    await lumine.views.getNextUpdatePromise();

    expect(selectList.element.querySelector(".select-list-separator")).toBeNull();
  });

  it("records a file when it is opened, most recent first", () => {
    spyOn(lumine.workspace, "open").and.returnValue(Promise.resolve());
    spyOn(main.selectList, "getSelectedItem").and.returnValue("/tmp/alpha.txt");
    // performAction stats the path before opening it; a miss is reported and
    // the open still runs, which is the path under test here.
    main.performAction("open");

    expect(main.recentlyUsed[0]).toBe("/tmp/alpha.txt");
    expect(main.serialize()).toEqual({ recentlyUsed: main.recentlyUsed });
  });

  it("records the entry for every action over it, not only an open", () => {
    main.openExternalService = {
      openExternal: jasmine.createSpy("openExternal"),
      showInFolder: jasmine.createSpy("showInFolder"),
    };
    spyOn(main.selectList, "getSelectedItem").and.returnValue("/tmp/alpha.txt");
    spyOn(lumine.clipboard, "write");

    main.performAction("open-external");
    expect(main.openExternalService.openExternal).toHaveBeenCalledWith("/tmp/alpha.txt");
    expect(main.recentlyUsed).toEqual(["/tmp/alpha.txt"]);

    main.performAction("path", { op: "copy", rel: "a" });
    expect(lumine.clipboard.write).toHaveBeenCalledWith("/tmp/alpha.txt");
    expect(main.recentlyUsed).toEqual(["/tmp/alpha.txt"]);
  });

  it("opens an alt-clicked entry through open-external when the service is available", async () => {
    const open = spyOn(lumine.workspace, "open").and.returnValue(Promise.resolve());
    main.openExternalService = { openExternal: jasmine.createSpy("openExternal") };
    const selectList = await showList();
    await selectList.selectItem("/tmp/alpha.txt");
    const row = selectList.listItems[selectList.items.indexOf("/tmp/gamma.txt")].component.element;

    row.dispatchEvent(
      new MouseEvent("click", { altKey: true, button: 0, bubbles: true, cancelable: true }),
    );

    expect(main.openExternalService.openExternal).toHaveBeenCalledWith("/tmp/gamma.txt");
    expect(open).not.toHaveBeenCalled();
    expect(main.recentlyUsed).toEqual(["/tmp/gamma.txt"]);
  });

  it("keeps the ordinary click action for alt-click when open-external is unavailable", async () => {
    const open = spyOn(lumine.workspace, "open").and.returnValue(Promise.resolve());
    const selectList = await showList();
    const row = selectList.listItems[selectList.items.indexOf("/tmp/gamma.txt")].component.element;

    row.dispatchEvent(
      new MouseEvent("click", { altKey: true, button: 0, bubbles: true, cancelable: true }),
    );

    expect(open).toHaveBeenCalled();
    expect(open.calls.mostRecent().args[0]).toBe("/tmp/gamma.txt");
  });

  it("records nothing for a directory it only continued the query into", () => {
    // A directory the query walks into is not an entry the user acted on, and
    // recording one would fill the section with the path to every file opened.
    spyOn(main.selectList, "getSelectedItem").and.returnValue(__dirname);

    main.performAction("open");

    expect(main.recentlyUsed).toEqual([]);
    expect(main.selectList.getQueryEditor().getText()).toBe(__dirname + require("path").sep);
  });

  it("drops one entry from the section without closing the list", async () => {
    main.recordRecent("/tmp/gamma.txt");
    main.recordRecent("/tmp/beta.txt");
    const selectList = await showList();
    await selectList.selectItem("/tmp/beta.txt");

    lumine.commands.dispatch(selectList.element, "fuzzy-explorer:remove-from-recent");
    await lumine.views.getNextUpdatePromise();

    expect(main.recentlyUsed).toEqual(["/tmp/gamma.txt"]);
    expect(selectList.isVisible()).toBe(true);
    // The row is still the selected one, at the place its own name puts it.
    expect(selectList.getSelectedItem()).toBe("/tmp/beta.txt");
    expect(selectList.items[0]).toBe("/tmp/gamma.txt");
  });

  it("stays open when the action is run from the item-actions list", async () => {
    // The path the action is actually reached by: Shift+F10, pick the row, and the
    // list returns here and dispatches. Nothing along it may close the picker.
    main.recordRecent("/tmp/gamma.txt");
    main.recordRecent("/tmp/beta.txt");
    const selectList = await showList();
    await selectList.selectItem("/tmp/beta.txt");

    await selectList.showItemActions();
    expect(selectList.itemActionsList.isVisible()).toBe(true);
    selectList.runItemAction("fuzzy-explorer:remove-from-recent");
    await lumine.views.getNextUpdatePromise();

    expect(main.recentlyUsed).toEqual(["/tmp/gamma.txt"]);
    expect(selectList.isVisible()).toBe(true);
    expect(selectList.itemActionsList.isVisible()).toBe(false);
    expect(selectList.getSelectedItem()).toBe("/tmp/beta.txt");
  });

  it("offers the action only while a recent entry is selected", async () => {
    main.recordRecent("/tmp/beta.txt");
    const selectList = await showList();

    await selectList.selectItem("/tmp/beta.txt");
    let actions = selectList.itemActions().map((action) => action.command);
    expect(actions).toContain("fuzzy-explorer:remove-from-recent");

    await selectList.selectItem("/tmp/alpha.txt");
    actions = selectList.itemActions().map((action) => action.command);
    expect(actions).not.toContain("fuzzy-explorer:remove-from-recent");
    // The rest of the package's actions are unaffected by the filter.
    expect(actions).toContain("fuzzy-explorer:open-external");
  });

  it("caps the list at the configured count", () => {
    lumine.config.set("fuzzy-explorer.recentCount", 2);
    main.recordRecent("/tmp/alpha.txt");
    main.recordRecent("/tmp/beta.txt");
    main.recordRecent("/tmp/gamma.txt");

    expect(main.recentlyUsed).toEqual(["/tmp/gamma.txt", "/tmp/beta.txt"]);
  });

  it("forgets everything on clear-recent", async () => {
    main.recordRecent("/tmp/beta.txt");
    const selectList = await showList();

    lumine.commands.dispatch(workspaceElement, "fuzzy-explorer:clear-recent");
    await lumine.views.getNextUpdatePromise();

    expect(main.recentlyUsed).toEqual([]);
    expect(selectList.element.querySelector(".select-list-separator")).toBeNull();
  });

  it("restores what it serialized", async () => {
    main.recordRecent("/tmp/beta.txt");
    expect(main.serialize()).toEqual({ recentlyUsed: ["/tmp/beta.txt"] });

    // Deactivation stores what serialize() returned, and the package activates
    // on its commands, so the round trip needs one dispatched to complete.
    await lumine.packages.deactivatePackage("fuzzy-explorer");
    const activation = lumine.packages.activatePackage("fuzzy-explorer");
    lumine.commands.dispatch(workspaceElement, "fuzzy-explorer:toggle");
    const pack = await activation;
    pack.mainModule.selectList.hide();

    expect(pack.mainModule.recentlyUsed).toEqual(["/tmp/beta.txt"]);
  });
});
