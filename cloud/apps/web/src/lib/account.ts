import React from 'react';
export interface AccountSession {
  userId: string;
  signOut: () => Promise<void>;
  busy: boolean;
  error: string;
  server: string;
}
export const AccountContext = React.createContext<AccountSession | null>(null);
export const useAccount = () => React.useContext(AccountContext);
