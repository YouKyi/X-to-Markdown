// Hand-written declarations for the browser.* surface this extension actually uses.
//
// Deliberately not @types/firefox-webext-browser: a 40-line file you wrote is
// more auditable than a 4000-line community one, and it doubles as documentation
// of exactly which privileged APIs this extension can reach.

declare const __VERSION__: string;
declare const __DEV__: boolean;

declare namespace browser {
  namespace runtime {
    const id: string;
    function getURL(path: string): string;
    function sendMessage<T = unknown, R = unknown>(message: T): Promise<R>;
    function openOptionsPage(): Promise<void>;
    const lastError: { message?: string } | undefined;
    const onMessage: {
      addListener(
        cb: (
          message: unknown,
          sender: { tab?: { id?: number }; url?: string },
        ) => Promise<unknown> | true | undefined | void,
      ): void;
    };
  }

  namespace storage {
    interface StorageArea {
      get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
      remove(keys: string | string[]): Promise<void>;
    }
    const sync: StorageArea;
    const local: StorageArea;
    const onChanged: {
      addListener(
        cb: (changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, area: string) => void,
      ): void;
    };
  }

  namespace downloads {
    interface DownloadOptions {
      url: string;
      filename?: string;
      saveAs?: boolean;
      conflictAction?: 'uniquify' | 'overwrite' | 'prompt';
    }
    function download(options: DownloadOptions): Promise<number>;
    const onChanged: {
      addListener(
        cb: (delta: { id: number; state?: { current: string } }) => void,
      ): void;
    };
  }

  namespace permissions {
    interface Permissions {
      permissions?: string[];
      origins?: string[];
    }
    function contains(p: Permissions): Promise<boolean>;
    function request(p: Permissions): Promise<boolean>;
  }

  namespace action {
    const onClicked: {
      addListener(cb: (tab: { id?: number; url?: string }) => void): void;
    };
  }

  namespace tabs {
    function sendMessage<T = unknown, R = unknown>(tabId: number, message: T): Promise<R>;
    function query(q: { active?: boolean; currentWindow?: boolean }): Promise<{ id?: number; url?: string }[]>;
  }
}

// Firefox also exposes the `chrome` namespace; we never use it, but declaring it
// as unknown makes an accidental reference a type error rather than an `any`.
declare const chrome: unknown;
