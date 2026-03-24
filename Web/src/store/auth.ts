import { create } from 'zustand';
import type { User } from '../types';

interface Account {
  user: User;
  token: string;
}

interface AuthState {
  accounts: Account[];
  activeUid: number | null;
  user: User | null;
  token: string | null;
  isAuthenticated: boolean;
  addAccount: (user: User, token: string) => void;
  switchAccount: (uid: number) => void;
  removeAccount: (uid: number) => void;
  logout: () => void;
}

const getInitialState = () => {
  const accountsStr = localStorage.getItem('accounts');
  const activeUidStr = localStorage.getItem('activeUid');
  
  const accounts: Account[] = accountsStr ? JSON.parse(accountsStr) : [];
  const activeUid = activeUidStr ? parseInt(activeUidStr, 10) : null;
  
  const activeAccount = accounts.find(a => a.user.uid === activeUid);
  
  return {
    accounts,
    activeUid: activeAccount ? activeUid : (accounts.length > 0 ? accounts[0].user.uid : null),
    user: activeAccount ? activeAccount.user : (accounts.length > 0 ? accounts[0].user : null),
    token: activeAccount ? activeAccount.token : (accounts.length > 0 ? accounts[0].token : null),
    isAuthenticated: accounts.length > 0,
  };
};

export const useAuthStore = create<AuthState>((set, get) => ({
  ...getInitialState(),

  addAccount: (user, token) => {
    const { accounts } = get();
    const existingIndex = accounts.findIndex(a => a.user.uid === user.uid);
    let newAccounts = [...accounts];
    
    if (existingIndex > -1) {
      newAccounts[existingIndex] = { user, token };
    } else {
      newAccounts.push({ user, token });
    }
    
    localStorage.setItem('accounts', JSON.stringify(newAccounts));
    localStorage.setItem('activeUid', user.uid.toString());
    
    set({
      accounts: newAccounts,
      activeUid: user.uid,
      user,
      token,
      isAuthenticated: true
    });
  },

  switchAccount: (uid) => {
    const { accounts } = get();
    const account = accounts.find(a => a.user.uid === uid);
    if (account) {
      localStorage.setItem('activeUid', uid.toString());
      set({
        activeUid: uid,
        user: account.user,
        token: account.token,
        isAuthenticated: true
      });
    }
  },

  removeAccount: (uid) => {
    const { accounts, activeUid } = get();
    const newAccounts = accounts.filter(a => a.user.uid !== uid);
    localStorage.setItem('accounts', JSON.stringify(newAccounts));
    
    if (activeUid === uid) {
      const nextAccount = newAccounts.length > 0 ? newAccounts[0] : null;
      if (nextAccount) {
        localStorage.setItem('activeUid', nextAccount.user.uid.toString());
        set({
          accounts: newAccounts,
          activeUid: nextAccount.user.uid,
          user: nextAccount.user,
          token: nextAccount.token,
          isAuthenticated: true
        });
      } else {
        localStorage.removeItem('activeUid');
        set({
          accounts: newAccounts,
          activeUid: null,
          user: null,
          token: null,
          isAuthenticated: false
        });
      }
    } else {
      set({ accounts: newAccounts });
    }
  },

  logout: () => {
    const { activeUid } = get();
    if (activeUid) {
      get().removeAccount(activeUid);
    }
  },
}));
