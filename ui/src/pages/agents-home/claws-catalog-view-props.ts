import type {
  ClawAddReviewPlan,
  ClawCatalogDetail,
  ClawCatalogEntry,
} from "./claws-catalog-client.ts";

export type ClawsCatalogViewProps = {
  /** Read only inside the catalog Loading/Errored slot. */
  readEntries: () => ClawCatalogEntry[];
  catalogRequest: Promise<ClawCatalogEntry[]> | undefined;
  basePath: string;
  query: string;
  selected: ClawCatalogEntry | null;
  pageMode: boolean;
  detail: ClawCatalogDetail | null;
  detailLoading: boolean;
  detailError: string | null;
  installedPluginPackages: ReadonlySet<string>;
  addError: string | null;
  applying: boolean;
  consentWarning: string | null;
  reviewPlan: ClawAddReviewPlan | null;
  addedAgentId: string | null;
  canAdd: boolean;
  onOpenPreview: (kind: "instruction" | "skill", name: string) => void;
  onSearch: (query: string) => void;
  onSelect: (entry: ClawCatalogEntry) => void;
  onBack: () => void;
  onClose: () => void;
  onRetryCatalog: () => void;
  onRetryDetail: () => void;
  onConfirm: () => void;
  onConfirmConsent: () => void;
  onCancelConsent: () => void;
  onConfirmReview: () => void;
  onCancelReview: () => void;
  onRetryOpenChat: () => void;
};
