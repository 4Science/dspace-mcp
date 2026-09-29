/**
 * TypeScript types for DSpace 7+ REST API entities.
 * Based on the DSpace REST Contract: https://github.com/DSpace/RestContract
 */

// ─── Metadata ────────────────────────────────────────────────

export interface MetadataValue {
  value: string;
  language?: string | null;
  authority?: string | null;
  confidence?: number;
  place?: number;
}

/** Metadata map: key is the schema-qualified field name, e.g. "dc.title" */
export type MetadataMap = Record<string, MetadataValue[]>;

// ─── Core Entities ───────────────────────────────────────────

export interface DSpaceObject {
  uuid: string;
  name: string;
  handle?: string;
  type: string;
  metadata: MetadataMap;
  _links?: Record<string, HalLink | HalLink[]>;
}

export interface Item extends DSpaceObject {
  type: 'item';
  inArchive: boolean;
  discoverable: boolean;
  withdrawn: boolean;
  lastModified: string;
  entityType?: string;
}

export interface Community extends DSpaceObject {
  type: 'community';
  archivedItemsCount?: number;
}

export interface Collection extends DSpaceObject {
  type: 'collection';
  archivedItemsCount?: number;
}

export interface Bundle extends DSpaceObject {
  type: 'bundle';
}

export interface Bitstream extends DSpaceObject {
  type: 'bitstream';
  bundleName?: string;
  sizeBytes?: number;
  checkSum?: {
    checkSumAlgorithm: string;
    value: string;
  };
}

// ─── HAL ─────────────────────────────────────────────────────

export interface HalLink {
  href: string;
}

export interface PageInfo {
  size: number;
  totalElements: number;
  totalPages: number;
  number: number;
}

export interface HalPage<T> {
  _embedded: Record<string, T[]>;
  page: PageInfo;
  _links: Record<string, HalLink>;
}

// ─── Search ──────────────────────────────────────────────────

export interface SearchResultEntry {
  hitHighlights?: Record<string, { name: string; value: string }[]>;
  _embedded: {
    indexableObject: DSpaceObject;
  };
}

export interface SearchResponse {
  query: string;
  scope?: string;
  appliedFilters?: Array<{ filter: string; operator: string; value: string }>;
  sort?: { by: string; order: string };
  _embedded: {
    searchResult: {
      _embedded: {
        objects: SearchResultEntry[];
      };
      page: PageInfo;
    };
    facets?: Array<{
      name: string;
      facetType: string;
      _embedded: {
        values: Array<{ label: string; count: number }>;
      };
    }>;
  };
}

// ─── Authentication ──────────────────────────────────────────

export interface AuthStatus {
  okay: boolean;
  authenticated: boolean;
  authenticationMethod?: string;
  _embedded?: {
    eperson: EPerson;
  };
  _links: Record<string, HalLink>;
}

export interface EPerson {
  uuid: string;
  email: string;
  name: string;
  type: 'eperson';
  netid?: string;
  lastActive?: string;
  canLogIn: boolean;
  requireCertificate: boolean;
  selfRegistered: boolean;
  metadata: MetadataMap;
}

// ─── Submission ──────────────────────────────────────────────

export interface WorkspaceItem {
  id: number;
  lastModified: string;
  sections: Record<string, unknown>;
  type: 'workspaceitem';
  _embedded?: {
    item?: Item;
    collection?: Collection;
  };
  _links?: Record<string, HalLink>;
}

// ─── JSON Patch (RFC 6902) ───────────────────────────────────

export type PatchOperation =
  | { op: 'add'; path: string; value: unknown }
  | { op: 'remove'; path: string }
  | { op: 'replace'; path: string; value: unknown }
  | { op: 'move'; from: string; path: string };

// ─── Auth state held in memory ───────────────────────────────

export interface AuthState {
  token: string | null;
  csrfToken: string | null;
  csrfCookie: string | null;
}
