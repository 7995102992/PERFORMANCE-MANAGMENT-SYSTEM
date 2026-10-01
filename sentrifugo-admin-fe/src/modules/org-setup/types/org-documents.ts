export interface FolderAccess {
  businessUnits: string[];
  departments: string[];
  workerTypes: string[];
}

export interface AttachedFile {
  name: string;
  size: number;   // bytes
  mimeType: string;
  url?: string;   // populated after upload
}

export interface OrgDocument {
  id: string;
  folderId: string;
  title: string;
  description: string;
  allowDownload: boolean;
  requireAcknowledgement: boolean;
  isActive: boolean;
  file: AttachedFile;
  updatedAt: string; // ISO date string
}

export interface DocumentFolder {
  id: string;
  name: string;
  description: string;
  customAccess: boolean;
  access: FolderAccess;
  isActive: boolean;
  updatedAt: string; // ISO date string
}
