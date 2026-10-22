export interface WorkspaceSummary {
  id: string;
  name: string;
  role: string;
}

export interface AuthContext {
  userId: string;
  sessionId: string;
  email: string;
  role: string;
  workspaceId: string;
  workspaceName: string;
  workspaceRole: string;
  memberships: WorkspaceSummary[];
}

export interface PublicIdentity {
  id: string;
  email: string;
  role: string;
  workspaceId: string;
  workspaceName: string;
  workspaceRole: string;
  workspaces: WorkspaceSummary[];
}

export interface AuthState {
  authRequired: boolean;
  user: PublicIdentity | null;
}
