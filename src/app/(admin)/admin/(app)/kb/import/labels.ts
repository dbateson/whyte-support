export const JOB_KIND = { mbox: "Emails (.mbox)", eml: "Emails (.eml)", zoho_csv: "Zoho cases", web: "whytebikes.com", ticket: "Resolved tickets" } as const;

export const JOB_STATUS = {
  importing: { label: "Reading", tone: "warning" },
  extracting: { label: "Finding answers", tone: "warning" },
  drafting: { label: "Drafting articles", tone: "warning" },
  done: { label: "Done", tone: "success" },
  failed: { label: "Failed", tone: "error" },
  cancelled: { label: "Cancelled", tone: "neutral" },
} as const;
