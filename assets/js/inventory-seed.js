// ============================================================
//  Workstation inventory — seed data
//  Imported from the Coda "Inventory / Workstations" table.
//  Columns there: Model 2 | Column 2 (status) | Serial Number | Assigned To | (date)
//  This is only used to populate Firestore the FIRST time the
//  Inventory tab is opened. After that, Firestore is the source of truth.
// ============================================================

export const INVENTORY_SEED = [
  { category: "CPU", model: "Beelink",      status: "Assigned", serial: "4CC2DC9D-55E9-436D-B6E1-BB2510CE76E2", assigned_to: "Adrian",                     since: "" },
  { category: "CPU", model: "Beelink",      status: "Assigned", serial: "5B90BC60-9ED3-450C-8D6E-17E52CDF97A2", assigned_to: "Agustin",                    since: "" },
  { category: "CPU", model: "Beelink",      status: "Assigned", serial: "7773E6E1-DF43-49BE-B89F-55F77F921C0C", assigned_to: "Albero Rios",                since: "2025-06-16" },
  { category: "CPU", model: "Beelink",      status: "Assigned", serial: "7773E6E1-DF43-49BE-B89F-55F77F921C0C", assigned_to: "albert",                     since: "" },
  { category: "CPU", model: "Beelink",      status: "Assigned", serial: "A4149459-DA6B-4ACB-93CD-A678E2B6E517", assigned_to: "Alejandro",                  since: "" },
  { category: "CPU", model: "Beelink",      status: "Assigned", serial: "8582551G80403",                        assigned_to: "Alejandro Camacho Contador", since: "2025-08-14" },
  { category: "CPU", model: "Beelink",      status: "Assigned", serial: "6CFB5C9D-4CF0-4F4A-92D2-A44D57156568", assigned_to: "Anahi",                      since: "" },
  { category: "CPU", model: "HP Elitedesk", status: "Assigned", serial: "4A4E5017-9789-4739-AF32-39D0C4918D80", assigned_to: "Angela",                     since: "" },
  { category: "CPU", model: "",             status: "Assigned", serial: "D5B8A4EA-CA7D-40BF-BA35-7EB81EE94CB9", assigned_to: "Aris",                       since: "" },
  { category: "CPU", model: "HP Elitedesk", status: "Assigned", serial: "6CDB582D-8011-47F7-B1B8-59324487594B", assigned_to: "Axel",                       since: "" },
  { category: "CPU", model: "Beelink",      status: "Assigned", serial: "3C956366-B3F0-43EF-AEF0-024865A05FA1", assigned_to: "Bernardo",                   since: "" },
  { category: "CPU", model: "Beelink",      status: "Assigned", serial: "425FEE89-3D08-43C8-9B7B-EA5134B4D9D5", assigned_to: "Christa",                    since: "" },
  { category: "CPU", model: "Beelink",      status: "Assigned", serial: "D48679EF-77B6-4CD5-9D38-547D8A04B512", assigned_to: "David",                      since: "" },
  { category: "CPU", model: "Beelink",      status: "Assigned", serial: "892BEE81-CD80-4D30-81F8-5A17DCCCC805", assigned_to: "Dayanira",                   since: "" },
  { category: "CPU", model: "HP Elitedesk", status: "Assigned", serial: "7B6E6216-6462-4590-A1CC-97958D9D8C1EBZRWH4ZN501511F", assigned_to: "Fernando",    since: "" },
  { category: "CPU", model: "Beelink",      status: "Assigned", serial: "38B817CE-0042-41BA-A882-6BA147DD50F6", assigned_to: "Gabriel",                    since: "" },
  { category: "CPU", model: "Beelink",      status: "Assigned", serial: "77BB71BF-3A8C-4BBD-9CFB-0837C33A0355", assigned_to: "Joel",                       since: "" },
  { category: "CPU", model: "HP Elitedesk", status: "Assigned", serial: "MXL92231Q3",                           assigned_to: "Kilian",                     since: "" },
  { category: "CPU", model: "HP Elitedesk", status: "Assigned", serial: "ABA20ACB-B8B7-43B1-A52B-0CB5ACC75F4F", assigned_to: "Luise Lesley",               since: "" },
  { category: "CPU", model: "HP Elitedesk", status: "Assigned", serial: "MXL0262PK6",                           assigned_to: "Marco",                      since: "" },
  { category: "CPU", model: "Beelink",      status: "Assigned", serial: "4CC2DC9D-55E9-436D-B6E1-BB2510CE76E2", assigned_to: "Mariana",                    since: "" },
  { category: "CPU", model: "HP Elitedesk", status: "Assigned", serial: "3232E8C8-B32B-4DCE-A5AE-DD31A2EA30E4", assigned_to: "Odeth",                      since: "" },
  { category: "CPU", model: "HP Elitedesk", status: "Assigned", serial: "F16C8BB0-6662-4E04-BC8E-414B60C00BE4", assigned_to: "Oliver",                     since: "" },
  { category: "CPU", model: "Beelink",      status: "Assigned", serial: "1FCBF63E-9FA8-4486-A797-84F8E87CDA52", assigned_to: "roman",                      since: "" },
  { category: "CPU", model: "HP Elitedesk", status: "Assigned", serial: "E069B51F-F9B7-4B26-8B86-B94C9088886A", assigned_to: "Roy",                        since: "" },
  { category: "CPU", model: "Beelink",      status: "Assigned", serial: "F353C3C6-9E34-4D79-B972-0A2170D920E6", assigned_to: "Samantha",                   since: "" },
  { category: "CPU", model: "HP Elitedesk", status: "Assigned", serial: "MXL02639GQ",                           assigned_to: "Saul",                       since: "" },
  { category: "CPU", model: "Beelink",      status: "Assigned", serial: "4CC2DC9D-55E9-436D-B6E1-BB2510CE76E2", assigned_to: "Silvio",                     since: "" },
  { category: "CPU", model: "Beelink",      status: "Assigned", serial: "7773E6E1-DF43-49BE-B89F-55F77F921C0C", assigned_to: "ximena",                     since: "" },
];

export const INVENTORY_STATUSES = ["Assigned", "Unassigned", "In repair", "Retired", "Lost"];

// Device categories. Everyone gets a slot for each; Monitor allows up to 3.
export const INVENTORY_CATEGORIES = ["CPU", "Monitor", "Mouse", "Keyboard", "Headset", "Laptop", "Extras"];
export const CATEGORY_MAX = { Monitor: 3 };
export const INVENTORY_MODELS = ["Beelink", "HP Elitedesk", "GEEKOM", "Laptop", "Other"];
