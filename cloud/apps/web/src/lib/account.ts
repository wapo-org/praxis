import React from 'react';
export interface AccountSession {
  userId: string;
  displayName?: string;
  email?: string;
  signOut: () => Promise<void>;
  /** Erases server account then local data; rejects with API error. */
  deleteAccount: (password: string) => Promise<void>;
  busy: boolean;
  error: string;
  server: string;
}
export const AccountContext = React.createContext<AccountSession | null>(null);
export const useAccount = () => React.useContext(AccountContext);
