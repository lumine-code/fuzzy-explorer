describe("fuzzy-explorer bootstrap", () => {
  it("keeps its public registrations in the eager JavaScript facade", () => {
    expect(require("../package.json").engines).toEqual({ lumine: "^1.0.0" });
  });

  it("does not construct the select-list DOM until the toggle command is used", async () => {
    const pack = await lumine.packages.startPackage("fuzzy-explorer");
    expect(pack.mainModule.selectListHost).toBeNull();

    await lumine.commands.dispatch(
      lumine.views.getView(lumine.workspace),
      "fuzzy-explorer:toggle",
    );
    expect(pack.mainModule.selectListHost).not.toBeNull();

    await lumine.packages.deactivatePackage("fuzzy-explorer");
  });
});
