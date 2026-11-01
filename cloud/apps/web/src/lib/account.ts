import React from 'react';
export interface AccountSession {
  userId: string;
  signOut: () => Promise<void>;
  /** Erases the account on the server, then this device's local data; rejects with the API's message. */
  deleteAccount: (password: string) => Promise<void>;
  busy: boolean;
  error: string;
  server: string;
}
export const AccountContext = React.createContext<AccountSession | null>(null);
export const useAccount = () => React.useContext(AccountContext);
