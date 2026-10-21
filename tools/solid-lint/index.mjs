// Resolve the plugin's typescript-eslint dependencies with their supported compiler.
import solid from "eslint-plugin-solid";

const removedApi = solid.rules["removed-api"];

export default {
  ...solid,
  rules: {
    ...solid.rules,
    "removed-api": {
      ...removedApi,
      create(context) {
        return removedApi.create(
          Object.create(context, {
            report: {
              value(diagnostic) {
                // Solid 2 rc.16 exports createDeferred from core again.
                if (
                  diagnostic.messageId === "removed" &&
                  diagnostic.data.name === "createDeferred" &&
                  diagnostic.node.parent.source.value === "solid-js"
                ) {
                  return;
                }
                context.report(diagnostic);
              },
            },
          }),
        );
      },
    },
  },
};
