import { action, createOptimistic, onSettled } from "solid-js";

export function createAgentsPagePresentation() {
  let lifetime = Promise.withResolvers<void>();
  const [identitySaving, setIdentitySaving] = createOptimistic(false);
  const presentIdentitySave = action(function* (completion: Promise<void>, retired: Promise<void>) {
    setIdentitySaving(true);
    yield Promise.race([completion, retired]);
  });
  onSettled(() => () => lifetime.resolve());
  return {
    // Scope changes release presentation; the owner still settles its admitted write.
    retire() {
      lifetime.resolve();
      lifetime = Promise.withResolvers<void>();
    },
    identitySaving,
    saveIdentity(completion: Promise<void>) {
      const retired = lifetime.promise;
      onSettled(() => {
        void presentIdentitySave(completion, retired);
      });
    },
  };
}
