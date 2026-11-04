export type ChatContentPart =
  | {
      type: 'text';
      text: string;
    }
  | {
      type: 'attachment';
      attachment: ChatAttachment;
    }
  | {
      type: 'image_url';
      image_url: {
        url: string;
        detail?: 'auto' | 'low' | 'high';
      };
    };

export interface ChatAttachment {
  id: string;
  name: string;
  size: number;
  contentType: string;
  storageKey: string;
  uploadedAt: string;
}
