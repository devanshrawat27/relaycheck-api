export interface AuthContext {
  userId: string;
  email: string;
  role: string;
  workspaceId: string;
  workspaceName: string;
}

export interface PublicIdentity {
  id: string;
  email: string;
  role: string;
  workspaceId: string;
  workspaceName: string;
}

export interface AuthState {
  authRequired: boolean;
  user: PublicIdentity | null;
}
