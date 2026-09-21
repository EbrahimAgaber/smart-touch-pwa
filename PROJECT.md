# Project: Smart Touch POS PWA & Desktop Sync Architecture Analysis

## Architecture
- **Desktop POS Engine (`c:\my-pos\v2`)**: Electron + SQLite local-first architecture. Runs background synchronization worker (`supabaseSync.cjs`) polling SQLite `sync_queue` every 5 seconds, pushing shifts, live stats, and pulling remote expenses.
- **Cloud Backend (Supabase PostgreSQL & Edge RPCs)**: Multi-tenant relational store with Row Level Security (RLS) containing tables `pairing_codes`, `owner_licenses`, `shop_live_stats`, `shop_shifts`, `remote_expenses`, and RPC procedures `exchange_pairing_code`, `push_shift_data`, `set_live_stats_batch`, `pull_pending_expenses`.
- **Companion Mobile PWA (`c:\my-pos\pwa`)**: React 18, Vite, Tailwind CSS v4, Lucide icons, Supabase JS client. Provides live sales monitoring, shift inspection, remote expense submission, and branch selection for shop owners.

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | Sync Bridge & RPC Data Flow Audit | Exact data structures, schemas, and payload specifications for exchange_pairing_code, push_shift_data, set_live_stats_batch, pull_pending_expenses | M1 | Survey Explorer 1 |
| 2 | Security & Pairing Lifecycle Analysis | Anonymous auth risks, pairing token TTL/replay vulnerabilities, Safari ITP 7-day wipe, multi-tenant TRIAL collisions | M1 | Survey Explorer 1 & 2 |
| 3 | Sync Failure Modes & Edge Cases | Pull atomicity gap, offline desktop queueing, AST/UTC timezone shifts, dormant pushLiveSale | M1 | Survey Explorer 1 |
| 4 | Competitive Feature Gap Matrix | Benchmark vs Square, Loyverse, Foodics across 6 core domains with business impact & complexity | M2 | Survey Explorer 3 |
| 5 | Multi-Shop Owner Architecture | Durable auth (phone/magic link), multi-store pairing, RLS multi-tenancy, conflict resolution | M3 | Survey Explorer 3 |
| 6 | Instant Branch Switcher & Aggregation | `useBranchStore` zero-latency switcher, Consolidated Executive Dashboard ("All Branches") | M3 | Survey Explorer 3 |
| 7 | Multi-Store User Journeys | Step-by-step journeys for: (a) pairing 2nd/3rd shop, (b) switching branch context, (c) viewing aggregate totals | M3 | Survey Explorer 3 |
| 8 | Responsive Mobile-First UX Blueprint | 360px-430px viewports, tablet optimization, bottom navigation, thumb-reach ergonomics | M4 | Survey Explorer 2 |
| 9 | RTL Arabic & Currency Localization | Arabic typography (Cairo font), correct RTL directionality, "ر.س" currency & thousands separators | M4 | Survey Explorer 2 |
| 10 | ASCII / UI Component Wireframes | Wireframes & layouts for Dashboard, Store Switcher Drawer, and Expense Submission | M4 | Survey Explorer 2 |
| 11 | PWA Offline, Caching & Push Blueprint | Service worker Workbox caching, manifest icons, install banner prompt, Web Push notification architecture | M4 | Survey Explorer 2 |
| 12 | 3-Phase Implementation Roadmap | Actionable P0 (Immediate Essentials), P1 (Multi-Branch & Analytics), P2 (Advanced Controls & Remote Ops) | M5 | Survey Explorer 3 |
| 13 | Master Strategic Deliverable Production | Exhaustive report authored and persisted at `PWA_END_TO_END_ANALYSIS_REPORT.md` | M6 | Orchestrator & Worker |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Sync & Architecture Technical Audit | Exact payloads, DB schemas, RPC contracts, failure modes, security | none | DONE |
| M2 | Competitive Gap Assessment | 6-domain benchmark vs Square, Loyverse, Foodics with impact & complexity | none | DONE |
| M3 | Multi-Shop Owner & Multi-Branch Design | User journeys, DB schema DDL, RPCs, consolidated aggregation, RLS | M1, M2 | DONE |
| M4 | Responsive Mobile-First UX & PWA Blueprint | Viewports 360-430px, RTL Arabic, UI Wireframes, Offline PWA | M1, M3 | DONE |
| M5 | Prioritized Implementation Roadmap | P0, P1, P2 roadmap with schema migrations, RPC contracts, frontend tasks | M1, M2, M3, M4 | DONE |
| M6 | Master Report Synthesis & Persistence | Authoring exhaustive `PWA_END_TO_END_ANALYSIS_REPORT.md` | M1-M5 | IN_PROGRESS |
| M7 | Multi-Agent Review, Challenge & Forensic Audit | Reviewer, Challenger, and Auditor verification gate | M6 | PLANNED |

## Interface Contracts & Data Payloads
### Desktop `supabaseSync.cjs` <-> Cloud Supabase
- `exchange_pairing_code(p_code TEXT, p_device_id UUID) -> { success: BOOLEAN, shop_id: UUID, shop_name: TEXT, license_key: TEXT }`
- `push_shift_data(p_license_key TEXT, p_shift_id BIGINT, p_shift_number INTEGER, p_cashier_name TEXT, p_start_time TIMESTAMPTZ, p_end_time TIMESTAMPTZ, p_total_sales NUMERIC, p_total_orders INTEGER, p_cash_sales NUMERIC, p_card_sales NUMERIC, p_credit_sales NUMERIC, p_status TEXT) -> VOID`
- `set_live_stats_batch(p_license_key TEXT, p_date DATE, p_total_sales NUMERIC, p_order_count INTEGER, p_cash_total NUMERIC, p_card_total NUMERIC, p_credit_total NUMERIC, p_active_shift_id BIGINT, p_last_order_time TIMESTAMPTZ) -> VOID`
- `pull_pending_expenses(p_license_key TEXT) -> TABLE(id BIGINT, amount NUMERIC, description TEXT, created_at TIMESTAMPTZ)`

### Multi-Shop Schema & RPC Extensions
- Tables: `organizations`, `shops`, `owner_profiles`, `shop_memberships`, `shop_shifts_v2`, `shop_inventory_items`, `shop_remote_commands`
- RPCs: `exchange_pairing_code_v2`, `get_consolidated_executive_stats`, `get_branch_leaderboard`, `push_shift_data_v2`, `add_remote_expense_v2`

## Code Layout
- Analysis metadata: `c:\my-pos\pwa\.agents/`
- Master Deliverable: `c:\my-pos\pwa\PWA_END_TO_END_ANALYSIS_REPORT.md`
