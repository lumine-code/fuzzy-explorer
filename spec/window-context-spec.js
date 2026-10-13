describe("window-local fuzzy-explorer dialogs", () => {
  beforeEach(async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
    await lumine.packages.activatePackage("fuzzy-explorer");
  });
  afterEach(async () => {
    await lumine.packages.deactivatePackage("fuzzy-explorer");
    await lumine.workspace.discardEditorWindows();
  });
  it("keeps concurrent queries in their own native documents and releases the closing host", async () => {
    const workspace = lumine.workspace;
    const mainWindow = workspace.getMainWindow();
    const first = await workspace.open();
    const extra = await workspace.openEditorWindow({ show: false });
    const second = workspace.buildTextEditor();
    extra.getEditorContainer().getActivePane().activateItem(second, { activatePane: true });
    await lumine.commands.dispatch(first.getElement(), "fuzzy-explorer:toggle");
    await lumine.commands.dispatch(second.getElement(), "fuzzy-explorer:toggle");
    const main = lumine.packages.getActivePackage("fuzzy-explorer").mainModule;
    const localHost = main.windowLists.get(mainWindow).host;
    const remoteHost = main.windowLists.get(extra).host;
    expect(localHost.isVisible()).toBe(true);
    expect(remoteHost.isVisible()).toBe(true);
    expect(remoteHost.getModel().getElement().ownerDocument).toBe(extra.getDocument());
    await localHost.getModel().setQuery("first");
    await remoteHost.getModel().setQuery("second");
    expect(localHost.getModel().getQuery()).toBe("first");
    expect(remoteHost.getModel().getQuery()).toBe("second");
    await workspace.attachWindow(extra);
    expect(main.windowLists.has(extra)).toBe(false);
    expect(localHost.getModel().getQuery()).toBe("first");
  });
});
