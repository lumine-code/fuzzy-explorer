// Authentic package usage. Run with lumine/script/demo.js; fixtures stay in demo/.
module.exports = {
  version: 1,
  dependencies: ["language-javascript", "tree-view"],
  viewport: { width: 1200, height: 760 },
  async before({ profile, fixture }) {
    require("node:fs").writeFileSync(
      require("node:path").join(profile, "explorer.json"),
      JSON.stringify([fixture("Signal Lab").replaceAll("\\", "/") + "/**/*"]),
    );
  },
  async prepare(context) {
    const { lumine, state, fixture, open } = context;
    state.editor = await open("Signal Lab/src/signal.js");
    await lumine.project.setPaths([fixture("Signal Lab")]);
  },
  scenes: [
    {
      id: "scene-1",
      file: "demo.png",
      caption: "Search configured directories for project files.",
      timeout: 60000,
      async run(context) {
        const { lumine, state } = context;
        {
          await lumine.packages.getActivePackage("fuzzy-explorer").mainModule.update();
          lumine.commands.dispatch(lumine.views.getView(state.editor), "fuzzy-explorer:toggle");
        }
      },
      ready() {
        return Boolean(document.querySelector(".fuzzy-explorer")?.innerText.includes("signal.js"));
      },
    },
  ],
  async cleanup() {},
};
