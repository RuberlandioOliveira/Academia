/* ============================================================================
   FERRO — Gestão de Academia (versão Supabase)

   COMO USAR:
   1) npm install @supabase/supabase-js
   2) Crie um projeto em supabase.com e rode o SQL abaixo no SQL Editor
   3) Preencha SUPABASE_URL e SUPABASE_ANON_KEY logo abaixo
   4) Este arquivo espera rodar dentro de um projeto React normal (Vite/Next),
      não dentro do preview de artifacts do Claude — que não carrega
      @supabase/supabase-js.

   -------------------- SQL (rodar uma vez no Supabase) ----------------------

   create table students (
     id uuid primary key default gen_random_uuid(),
     nome text not null, telefone text, plano text, matricula date,
     status text default 'ativo'
   );
   create table payments (
     id uuid primary key default gen_random_uuid(),
     student_id uuid references students(id) on delete cascade,
     mes_ref text, valor numeric, status text, data_pagamento date, vencimento date
   );
   create table workouts (
     id uuid primary key default gen_random_uuid(),
     student_id uuid references students(id) on delete cascade,
     nome text, tipo text, exercicios jsonb default '[]'
   );
   create table checkins (
     id uuid primary key default gen_random_uuid(),
     student_id uuid references students(id) on delete cascade,
     data date, hora text
   );
   create table evaluations (
     id uuid primary key default gen_random_uuid(),
     student_id uuid references students(id) on delete cascade,
     data date, peso numeric, altura numeric, gordura numeric,
     massa_muscular numeric, medidas jsonb default '{}', obs text
   );
   create table classes (
     id uuid primary key default gen_random_uuid(),
     nome text, dias text[], horario text, capacidade int,
     instrutor text, inscritos uuid[] default '{}'
   );
   create table profiles (
     id uuid primary key references auth.users(id) on delete cascade,
     email text, role text default 'recepcao'
   );
   create table settings (
     id int primary key default 1,
     nome text default 'FERRO', telefone text, endereco text, email text, logo_url text,
     constraint single_row check (id = 1)
   );
   insert into settings (id) values (1) on conflict do nothing;

   -- cria o profile automaticamente no cadastro (role inicial: recepcao)
   create function public.handle_new_user() returns trigger as $$
   begin
     insert into public.profiles (id, email) values (new.id, new.email);
     return new;
   end;
   $$ language plpgsql security definer;
   create trigger on_auth_user_created
     after insert on auth.users
     for each row execute procedure public.handle_new_user();

   -- RLS básica pra começar (refine depois por role conforme necessário)
   alter table students enable row level security;
   alter table payments enable row level security;
   alter table workouts enable row level security;
   alter table checkins enable row level security;
   alter table evaluations enable row level security;
   alter table classes enable row level security;
   alter table profiles enable row level security;
   create policy "auth read/write" on students for all using (auth.role() = 'authenticated');
   create policy "auth read/write" on payments for all using (auth.role() = 'authenticated');
   create policy "auth read/write" on workouts for all using (auth.role() = 'authenticated');
   create policy "auth read/write" on checkins for all using (auth.role() = 'authenticated');
   create policy "auth read/write" on evaluations for all using (auth.role() = 'authenticated');
   create policy "auth read/write" on classes for all using (auth.role() = 'authenticated');
   create policy "self read" on profiles for select using (auth.uid() = id);
   alter table settings enable row level security;
   create policy "public read" on settings for select using (true);
   create policy "auth write" on settings for update using (auth.role() = 'authenticated');

   -- bucket público para o logo da academia
   insert into storage.buckets (id, name, public) values ('logos', 'logos', true)
     on conflict do nothing;
   create policy "public read logos" on storage.objects for select using (bucket_id = 'logos');
   create policy "auth upload logos" on storage.objects for insert
     with check (bucket_id = 'logos' and auth.role() = 'authenticated');
   create policy "auth update logos" on storage.objects for update
     using (bucket_id = 'logos' and auth.role() = 'authenticated');

   Depois de criar o primeiro usuário, promova-o a "dono" manualmente na tabela
   profiles (Table Editor → profiles → editar a coluna role para 'dono').

   Se você já tinha criado a tabela "evaluations" antes, rode esta migração
   em vez de recriar a tabela:

   alter table evaluations add column altura numeric;
   alter table evaluations add column massa_muscular numeric;
   alter table evaluations add column medidas jsonb default '{}';

   Se você já tinha o banco criado antes da aba "Configurações" existir, rode
   esta migração em vez de recriar tudo:

   create table settings (
     id int primary key default 1,
     nome text default 'FERRO', telefone text, endereco text, email text, logo_url text,
     constraint single_row check (id = 1)
   );
   insert into settings (id) values (1) on conflict do nothing;
   alter table settings enable row level security;
   create policy "public read" on settings for select using (true);
   create policy "auth write" on settings for update using (auth.role() = 'authenticated');
   insert into storage.buckets (id, name, public) values ('logos', 'logos', true)
     on conflict do nothing;
   create policy "public read logos" on storage.objects for select using (bucket_id = 'logos');
   create policy "auth upload logos" on storage.objects for insert
     with check (bucket_id = 'logos' and auth.role() = 'authenticated');
   create policy "auth update logos" on storage.objects for update
     using (bucket_id = 'logos' and auth.role() = 'authenticated');

   Página do aluno: cada aluno recebe um link privado (sem login) baseado
   num token único. Rode isto também:

   alter table students add column if not exists access_token uuid unique default gen_random_uuid();

   create or replace function get_aluno_portal(token uuid)
   returns json
   language sql
   security definer
   as $$
     select json_build_object(
       'student', (select json_build_object('id', id, 'nome', nome, 'plano', plano, 'status', status) from students where access_token = token),
       'payments', (select coalesce(json_agg(p), '[]') from payments p where p.student_id = (select id from students where access_token = token)),
       'workouts', (select coalesce(json_agg(w), '[]') from workouts w where w.student_id = (select id from students where access_token = token)),
       'evaluations', (select coalesce(json_agg(e), '[]') from evaluations e where e.student_id = (select id from students where access_token = token)),
       'checkins', (select coalesce(json_agg(c), '[]') from checkins c where c.student_id = (select id from students where access_token = token))
     );
   $$;
   grant execute on function get_aluno_portal(uuid) to anon, authenticated;

   create or replace function aluno_checkin(token uuid)
   returns json
   language plpgsql
   security definer
   as $$
   declare sid uuid;
   begin
     select id into sid from students where access_token = token;
     if sid is null then raise exception 'Link inválido'; end if;
     insert into checkins (student_id, data, hora) values (sid, current_date, to_char(now(), 'HH24:MI'));
     return json_build_object('ok', true);
   end;
   $$;
   grant execute on function aluno_checkin(uuid) to anon, authenticated;

   Controle de contas: novas contas passam a nascer como "pendente" (sem
   acesso a nada) até o dono aprovar. O dono também passa a poder ver e
   alterar o nível de todas as contas. Rode isto também:

   create or replace function public.handle_new_user() returns trigger as $$
   begin
     insert into public.profiles (id, email, role) values (new.id, new.email, 'pendente');
     return new;
   end;
   $$ language plpgsql security definer;

   create or replace function is_dono()
   returns boolean
   language sql
   security definer
   stable
   as $$
     select role = 'dono' from profiles where id = auth.uid();
   $$;

   create policy "dono read all profiles" on profiles for select using (is_dono());
   create policy "dono update all profiles" on profiles for update using (is_dono());
   ========================================================================= */

import React, { useState, useMemo, useEffect, useCallback } from "react";
import { createClient } from "@supabase/supabase-js";
import {
  LayoutDashboard, Users, CreditCard, Dumbbell, CalendarCheck, Plus, Search, Check,
  Trash2, Flame, TrendingUp, AlertTriangle, Activity, CalendarDays, BarChart3,
  MessageCircle, Maximize2, Minimize2, Loader2, ShieldCheck, LogOut, Settings, Upload,
} from "lucide-react";
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";

// ---------- Supabase ----------
const SUPABASE_URL = "https://grxhispuduwibclhxnch.supabase.co"; // TODO: cole a Project URL
const SUPABASE_ANON_KEY = "sb_publishable_PgvQEQ42x1VL0BtWDtU9_Q_EnSQFCDq"; // TODO: cole a anon public key
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ---------- design tokens ----------
const C = {
  bg: "#EDEBE6", panel: "#FFFFFF", ink: "#000000", inkSoft: "#000000",
  sidebar: "#040f3c", sidebarSoft: "#055916", sidebarLine: "#ffffff",
  lime: "#C4F135", limeDark: "#9FCB1E", red: "#E0384B", redSoft: "#FBE3E6",
  greenSoft: "#E6F4D9", greenText: "#4C7A16", amberSoft: "#FBEDD3", amberText: "#9C6B10",
  blueSoft: "#E1EEF9", blueText: "#2B6CA3", border: "#DEDAD1",
};
const fontDisplay = { fontFamily: "'Bebas Neue', sans-serif", letterSpacing: "0.03em" };
const fontMono = { fontFamily: "'JetBrains Mono', monospace" };

const ALL_TABS = [
  { id: "dashboard", label: "Painel", icon: LayoutDashboard },
  { id: "alunos", label: "Alunos", icon: Users },
  { id: "mensalidades", label: "Mensalidades", icon: CreditCard },
  { id: "treinos", label: "Treinos", icon: Dumbbell },
  { id: "avaliacoes", label: "Avaliações", icon: Activity },
  { id: "turmas", label: "Turmas", icon: CalendarDays },
  { id: "frequencia", label: "Frequência", icon: CalendarCheck },
  { id: "relatorios", label: "Relatórios", icon: BarChart3 },
  { id: "configuracoes", label: "Configurações", icon: Settings },
];
const ROLE_TABS = {
  dono: ["dashboard", "alunos", "mensalidades", "treinos", "avaliacoes", "turmas", "frequencia", "relatorios", "configuracoes"],
  recepcao: ["dashboard", "alunos", "mensalidades", "turmas", "frequencia"],
  instrutor: ["dashboard", "treinos", "avaliacoes", "frequencia"],
  pendente: [],
  bloqueado: [],
};
const ROLE_LABELS = { dono: "Dono(a)", recepcao: "Recepção", instrutor: "Instrutor(a)", pendente: "Aguardando aprovação", bloqueado: "Bloqueado" };
const MONTHS = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
const WEEKDAYS = [
  { id: "SU", label: "Dom" }, { id: "MO", label: "Seg" }, { id: "TU", label: "Ter" },
  { id: "WE", label: "Qua" }, { id: "TH", label: "Qui" }, { id: "FR", label: "Sex" }, { id: "SA", label: "Sáb" },
];

function fmtBRL(v) { return (Number(v) || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }); }
function fmtDate(iso) { if (!iso) return "—"; return new Date(iso + "T00:00:00").toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" }); }
function todayISO() { return new Date().toISOString().slice(0, 10); }
function addDays(iso, n) { const d = new Date(iso + "T00:00:00"); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); }
function initials(name) { return name.split(" ").filter(Boolean).slice(0, 2).map((s) => s[0]).join("").toUpperCase(); }
function mesLabel(mesRef) { const [y, m] = mesRef.split("-"); return `${MONTHS[Number(m) - 1]}/${y.slice(2)}`; }
const today = todayISO();

// ---------- mapeamento camelCase (app) <-> snake_case (supabase) ----------
const TABLE_MAP = {
  students: {
    table: "students",
    toDb: (s) => ({ nome: s.nome, telefone: s.telefone, plano: s.plano, matricula: s.matricula, status: s.status }),
    fromDb: (r) => ({ id: r.id, nome: r.nome, telefone: r.telefone, plano: r.plano, matricula: r.matricula, status: r.status, accessToken: r.access_token }),
  },
  payments: {
    table: "payments",
    toDb: (p) => ({ student_id: p.studentId, mes_ref: p.mesRef, valor: p.valor, status: p.status, data_pagamento: p.dataPagamento, vencimento: p.vencimento }),
    fromDb: (r) => ({ id: r.id, studentId: r.student_id, mesRef: r.mes_ref, valor: Number(r.valor), status: r.status, dataPagamento: r.data_pagamento, vencimento: r.vencimento }),
  },
  workouts: {
    table: "workouts",
    toDb: (w) => ({ student_id: w.studentId, nome: w.nome, tipo: w.tipo, exercicios: w.exercicios }),
    fromDb: (r) => ({ id: r.id, studentId: r.student_id, nome: r.nome, tipo: r.tipo, exercicios: r.exercicios || [] }),
  },
  checkins: {
    table: "checkins",
    toDb: (c) => ({ student_id: c.studentId, data: c.data, hora: c.hora }),
    fromDb: (r) => ({ id: r.id, studentId: r.student_id, data: r.data, hora: r.hora }),
  },
  evaluations: {
    table: "evaluations",
    toDb: (e) => ({ student_id: e.studentId, data: e.data, peso: e.peso, altura: e.altura, gordura: e.gordura, massa_muscular: e.massaMuscular, medidas: e.medidas || {}, obs: e.obs }),
    fromDb: (r) => ({ id: r.id, studentId: r.student_id, data: r.data, peso: Number(r.peso), altura: r.altura == null ? null : Number(r.altura), gordura: r.gordura == null ? null : Number(r.gordura), massaMuscular: r.massa_muscular == null ? null : Number(r.massa_muscular), medidas: r.medidas || {}, obs: r.obs }),
  },
  classes: {
    table: "classes",
    toDb: (c) => ({ nome: c.nome, dias: c.dias, horario: c.horario, capacidade: c.capacidade, instrutor: c.instrutor, inscritos: c.inscritos }),
    fromDb: (r) => ({ id: r.id, nome: r.nome, dias: r.dias || [], horario: r.horario, capacidade: r.capacidade, instrutor: r.instrutor, inscritos: r.inscritos || [] }),
  },
};

async function fetchAll(entity) {
  const m = TABLE_MAP[entity];
  const { data, error } = await supabase.from(m.table).select("*");
  if (error) throw error;
  return data.map(m.fromDb);
}
async function insertRow(entity, obj) {
  const m = TABLE_MAP[entity];
  const { data, error } = await supabase.from(m.table).insert(m.toDb(obj)).select().single();
  if (error) throw error;
  return m.fromDb(data);
}
async function updateRow(entity, id, obj) {
  const m = TABLE_MAP[entity];
  const { data, error } = await supabase.from(m.table).update(m.toDb(obj)).eq("id", id).select().single();
  if (error) throw error;
  return m.fromDb(data);
}
async function deleteRow(entity, id) {
  const m = TABLE_MAP[entity];
  const { error } = await supabase.from(m.table).delete().eq("id", id);
  if (error) throw error;
}

async function fetchSettings() {
  const { data, error } = await supabase.from("settings").select("*").eq("id", 1).maybeSingle();
  if (error) throw error;
  if (!data) return { nome: "SISTEMA", telefone: "", endereco: "", email: "", logoUrl: "" };
  return { nome: data.nome || "SISTEMA", telefone: data.telefone || "", endereco: data.endereco || "", email: data.email || "", logoUrl: data.logo_url || "" };
}
async function saveSettings(patch) {
  const { data, error } = await supabase.from("settings")
    .update({ nome: patch.nome, telefone: patch.telefone, endereco: patch.endereco, email: patch.email, logo_url: patch.logoUrl })
    .eq("id", 1)
    .select().single();
  if (error) throw error;
  return { nome: data.nome || "SISTEMA", telefone: data.telefone || "", endereco: data.endereco || "", email: data.email || "", logoUrl: data.logo_url || "" };
}
async function uploadLogo(file) {
  const ext = file.name.split(".").pop();
  const path = `logo-${Date.now()}.${ext}`;
  const { error } = await supabase.storage.from("logos").upload(path, file, { upsert: true });
  if (error) throw error;
  const { data } = supabase.storage.from("logos").getPublicUrl(path);
  return data.publicUrl;
}

async function fetchAccounts() {
  const { data, error } = await supabase.from("profiles").select("id, email, role").order("email");
  if (error) throw error;
  return data;
}
async function updateAccountRole(id, role) {
  const { data, error } = await supabase.from("profiles").update({ role }).eq("id", id).select().single();
  if (error) throw error;
  return data;
}

// ---------- ui pieces (iguais à versão anterior) ----------
function Badge({ children, tone = "neutral" }) {
  const tones = { neutral: { bg: "#F0EEE9", color: C.inkSoft }, green: { bg: C.greenSoft, color: C.greenText }, amber: { bg: C.amberSoft, color: C.amberText }, red: { bg: C.redSoft, color: C.red }, blue: { bg: C.blueSoft, color: C.blueText } };
  const t = tones[tone];
  return <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold" style={{ background: t.bg, color: t.color }}>{children}</span>;
}
function Avatar({ name, size = 36 }) {
  return <div className="flex items-center justify-center rounded-full shrink-0" style={{ width: size, height: size, background: C.sidebar, color: C.lime, border: `2px solid ${C.lime}`, fontSize: size * 0.38, ...fontMono, fontWeight: 700 }}>{initials(name)}</div>;
}
function Panel({ children, style, className = "" }) {
  return <div className={"rounded-2xl " + className} style={{ background: C.panel, border: `1px solid ${C.border}`, ...style }}>{children}</div>;
}
function PrimaryButton({ children, onClick, type = "button", disabled }) {
  return <button type={type} onClick={onClick} disabled={disabled} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold transition-transform active:scale-95 disabled:opacity-50" style={{ background: C.lime, color: C.ink }}>{children}</button>;
}
function GhostButton({ children, onClick }) {
  return <button onClick={onClick} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors" style={{ borderColor: C.border, color: C.ink, background: "transparent" }}>{children}</button>;
}
function Field({ label, children }) {
  return <label className="flex flex-col gap-1 text-sm"><span style={{ color: C.inkSoft }} className="font-medium">{label}</span>{children}</label>;
}
const inputStyle = { border: `1px solid ${C.border}`, borderRadius: "0.5rem", padding: "0.5rem 0.7rem", fontSize: "0.9rem", background: "#FCFBF9", color: C.ink, width: "100%" };
function Header({ title, subtitle, action }) {
  return (
    <div className="flex items-end justify-between mb-6 flex-wrap gap-3">
      <div>
        <h1 style={{ ...fontDisplay, fontSize: "2.4rem", lineHeight: 1 }}>{title}</h1>
        {subtitle && <div className="text-sm mt-1" style={{ color: C.inkSoft }}>{subtitle}</div>}
      </div>
      {action}
    </div>
  );
}

// ---------- tela de login ----------
function Login({ settings }) {
  const [mode, setMode] = useState("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const { error } = mode === "signin"
        ? await supabase.auth.signInWithPassword({ email, password })
        : await supabase.auth.signUp({ email, password });
      if (error) setError(error.message);
    } catch (err) {
      setError(err.message || "Não foi possível conectar ao Supabase. Confira a URL e a chave.");
    }
    setLoading(false);
  }

  return (
    <div className="min-h-screen w-full flex items-center justify-center px-4" style={{ background: C.sidebar, fontFamily: "Inter, sans-serif" }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Inter:wght@400;500;600;700&display=swap');`}</style>
      <div className="w-full max-w-sm">
        {settings?.logoUrl ? (
          <img src={settings.logoUrl} alt="Logo" className="w-16 h-16 rounded-2xl object-cover mx-auto mb-3" />
        ) : (
          <div style={{ ...fontDisplay, fontSize: "2.6rem", color: C.lime, textAlign: "center" }}>{settings?.nome || "FERRO"}</div>
        )}
        {settings?.logoUrl && <div style={{ ...fontDisplay, fontSize: "1.8rem", color: C.lime, textAlign: "center" }}>{settings?.nome || "FERRO"}</div>}
        <div className="text-sm text-center mb-8" style={{ color: "#9A9A9E" }}>gestão da academia</div>
        <form onSubmit={submit} className="flex flex-col gap-3 p-6 rounded-2xl" style={{ background: C.sidebarSoft, border: `1px solid ${C.sidebarLine}` }}>
          <input required type="email" placeholder="e-mail" value={email} onChange={(e) => setEmail(e.target.value)} className="rounded-lg px-3 py-2 text-sm" style={{ background: "#1C1D21", color: "#fff", border: `1px solid ${C.sidebarLine}` }} />
          <input required type="password" placeholder="senha" value={password} onChange={(e) => setPassword(e.target.value)} className="rounded-lg px-3 py-2 text-sm" style={{ background: "#1C1D21", color: "#fff", border: `1px solid ${C.sidebarLine}` }} />
          {error && <div className="text-xs" style={{ color: C.red }}>{error}</div>}
          <button type="submit" disabled={loading} className="mt-1 py-2.5 rounded-lg text-sm font-bold disabled:opacity-50" style={{ background: C.lime, color: C.ink }}>
            {loading ? "Aguarde..." : mode === "signin" ? "Entrar" : "Criar conta"}
          </button>
          <button type="button" onClick={() => setMode(mode === "signin" ? "signup" : "signin")} className="text-xs mt-1" style={{ color: "#9A9A9E" }}>
            {mode === "signin" ? "Não tem conta? Criar uma" : "Já tem conta? Entrar"}
          </button>
        </form>
      </div>
    </div>
  );
}

// ================= APP =================
export default function GestaoAcademia() {
  const alunoToken = new URLSearchParams(window.location.search).get("aluno");
  if (alunoToken) return <AlunoPortal token={alunoToken} />;
  return <StaffApp />;
}

function StaffApp() {
  const [session, setSession] = useState(undefined); // undefined = carregando, null = deslogado
  const [role, setRole] = useState("recepcao");
  const [dataReady, setDataReady] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [tab, setTab] = useState("dashboard");
  const [settings, setSettings] = useState(null);
  const [students, setStudents] = useState([]);
  const [payments, setPayments] = useState([]);
  const [workouts, setWorkouts] = useState([]);
  const [checkins, setCheckins] = useState([]);
  const [evaluations, setEvaluations] = useState([]);
  const [classes, setClasses] = useState([]);

  useEffect(() => {
    fetchSettings().then(setSettings).catch(() => setSettings({ nome: "FERRO", telefone: "", endereco: "", email: "", logoUrl: "" }));
  }, []);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: listener } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => listener.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) return;
    (async () => {
      setDataReady(false);
      const { data: profile } = await supabase.from("profiles").select("role").eq("id", session.user.id).single();
      setRole(profile?.role || "recepcao");
      const [st, pa, wo, ch, ev, cl] = await Promise.all([
        fetchAll("students"), fetchAll("payments"), fetchAll("workouts"),
        fetchAll("checkins"), fetchAll("evaluations"), fetchAll("classes"),
      ]);
      setStudents(st); setPayments(pa); setWorkouts(wo); setCheckins(ch); setEvaluations(ev); setClasses(cl);
      setDataReady(true);
    })();
  }, [session]);

  // wrappers genéricos de escrita no banco
  const withError = useCallback(async (fn) => {
    try { setSaveError(false); return await fn(); } catch { setSaveError(true); return null; }
  }, []);

  const api = {
    students: {
      add: (obj) => withError(async () => { const row = await insertRow("students", obj); setStudents((p) => [...p, row]); }),
      update: (id, patch) => withError(async () => { const cur = students.find((s) => s.id === id); const row = await updateRow("students", id, { ...cur, ...patch }); setStudents((p) => p.map((s) => (s.id === id ? row : s))); }),
      remove: (id) => withError(async () => { await deleteRow("students", id); setStudents((p) => p.filter((s) => s.id !== id)); }),
    },
    payments: {
      add: (obj) => withError(async () => { const row = await insertRow("payments", obj); setPayments((p) => [...p, row]); }),
      update: (id, patch) => withError(async () => { const cur = payments.find((x) => x.id === id); const row = await updateRow("payments", id, { ...cur, ...patch }); setPayments((p) => p.map((x) => (x.id === id ? row : x))); }),
    },
    workouts: {
      add: (obj) => withError(async () => { const row = await insertRow("workouts", obj); setWorkouts((p) => [...p, row]); }),
      remove: (id) => withError(async () => { await deleteRow("workouts", id); setWorkouts((p) => p.filter((w) => w.id !== id)); }),
    },
    checkins: {
      add: (obj) => withError(async () => { const row = await insertRow("checkins", obj); setCheckins((p) => [...p, row]); }),
    },
    evaluations: {
      add: (obj) => withError(async () => { const row = await insertRow("evaluations", obj); setEvaluations((p) => [...p, row]); }),
      remove: (id) => withError(async () => { await deleteRow("evaluations", id); setEvaluations((p) => p.filter((e) => e.id !== id)); }),
    },
    classes: {
      add: (obj) => withError(async () => { const row = await insertRow("classes", obj); setClasses((p) => [...p, row]); }),
      update: (id, patch) => withError(async () => { const cur = classes.find((c) => c.id === id); const row = await updateRow("classes", id, { ...cur, ...patch }); setClasses((p) => p.map((c) => (c.id === id ? row : c))); }),
      remove: (id) => withError(async () => { await deleteRow("classes", id); setClasses((p) => p.filter((c) => c.id !== id)); }),
    },
    settings: {
      save: (patch) => withError(async () => { const s = await saveSettings(patch); setSettings(s); }),
    },
  };

  const studentName = (id) => students.find((s) => s.id === id)?.nome ?? "—";
  const visibleTabs = ALL_TABS.filter((t) => ROLE_TABS[role]?.includes(t.id));

  useEffect(() => {
    if (dataReady && ROLE_TABS[role]?.length > 0 && !ROLE_TABS[role].includes(tab)) setTab(ROLE_TABS[role][0]);
  }, [role, dataReady]);

  if (session === undefined) {
    return <div className="min-h-screen flex items-center justify-center" style={{ background: C.bg }}><Loader2 className="animate-spin" size={22} color={C.inkSoft} /></div>;
  }
  if (session === null) return <Login settings={settings} />;

  if (!dataReady) {
    return (
      <div className="min-h-screen w-full flex items-center justify-center" style={{ background: C.bg }}>
        <style>{`@import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@500;700&display=swap');`}</style>
        <div className="flex flex-col items-center gap-3" style={{ color: C.inkSoft, fontFamily: "Inter, sans-serif" }}>
          <Loader2 className="animate-spin" size={22} /><span className="text-sm">Carregando dados da academia...</span>
        </div>
      </div>
    );
  }

  if (role === "pendente" || role === "bloqueado") {
    return <AccessBlocked role={role} settings={settings} />;
  }

  return (
    <div className="min-h-screen w-full flex" style={{ background: C.bg, color: C.ink, fontFamily: "Inter, sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@500;700&display=swap');
        * { box-sizing: border-box; }
        ::selection { background: ${C.lime}; color: ${C.ink}; }
        button:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid ${C.lime}; outline-offset: 2px; }
        @media (prefers-reduced-motion: reduce) { *{ transition:none!important; animation:none!important; } }
      `}</style>

      {saveError && <div className="fixed top-3 right-3 z-50 px-4 py-2 rounded-lg text-xs font-semibold" style={{ background: C.redSoft, color: C.red }}>Não foi possível salvar no banco. Tente novamente.</div>}

      <aside className="hidden md:flex flex-col justify-between shrink-0" style={{ width: 224, background: C.sidebar, color: "#fff" }}>
        <div>
          <div className="px-6 pt-7 pb-5" style={{ borderBottom: `1px solid ${C.sidebarLine}` }}>
            {settings?.logoUrl ? (
              <img src={settings.logoUrl} alt="Logo" className="w-10 h-10 rounded-lg object-cover mb-1" />
            ) : (
              <div style={{ ...fontDisplay, fontSize: "2rem", lineHeight: 1, color: C.lime }}>{settings?.nome || "SISTEMA"}</div>
            )}
            {settings?.logoUrl && <div style={{ ...fontDisplay, fontSize: "1.3rem", lineHeight: 1, color: C.lime }}>{settings?.nome || "SISTEMA"}</div>}
            <div className="text-xs mt-1" style={{ color: "#9A9A9E" }}>gestão da academia</div>
          </div>
          <div className="px-6 pt-4 flex items-center gap-1.5 text-xs" style={{ color: "#9A9A9E" }}>
            <ShieldCheck size={13} /> {ROLE_LABELS[role] || role}
          </div>
          <nav className="px-3 pt-4 flex flex-col gap-1">
            {visibleTabs.map((t) => {
              const Icon = t.icon; const active = tab === t.id;
              return (
                <button key={t.id} onClick={() => setTab(t.id)} className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors" style={{ background: active ? C.sidebarSoft : "transparent", color: active ? C.lime : "#C7C7CB", borderLeft: active ? `3px solid ${C.lime}` : "3px solid transparent" }}>
                  <Icon size={17} />{t.label}
                </button>
              );
            })}
          </nav>
        </div>
        <div className="px-4 pb-6">
          <button onClick={() => supabase.auth.signOut()} className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs" style={{ color: "#ffffff" }}>
            <LogOut size={13} /> Sair
          </button>
        </div>
      </aside>

      <div className="md:hidden fixed bottom-0 left-0 right-0 flex justify-around py-2 z-20 overflow-x-auto" style={{ background: C.sidebar, borderTop: `1px solid ${C.sidebarLine}` }}>
        {visibleTabs.map((t) => {
          const Icon = t.icon; const active = tab === t.id;
          return (
            <button key={t.id} onClick={() => setTab(t.id)} className="flex flex-col items-center gap-0.5 px-2 py-1 shrink-0">
              <Icon size={17} color={active ? C.lime : "#ffffff"} /><span className="text-[9px]" style={{ color: active ? C.lime : "#8C8C90" }}>{t.label}</span>
            </button>
          );
        })}
      </div>

      <main className="flex-1 px-5 md:px-10 py-8 pb-24 md:pb-8 overflow-x-hidden">
        {tab === "dashboard" && <Dashboard students={students} payments={payments} checkins={checkins} studentName={studentName} />}
        {tab === "alunos" && <Alunos students={students} api={api.students} payments={payments} checkins={checkins} />}
        {tab === "mensalidades" && <Mensalidades students={students} payments={payments} api={api.payments} studentName={studentName} />}
        {tab === "treinos" && <Treinos students={students} workouts={workouts} api={api.workouts} studentName={studentName} />}
        {tab === "avaliacoes" && <Avaliacoes students={students} evaluations={evaluations} api={api.evaluations} />}
        {tab === "turmas" && <Turmas students={students} classes={classes} api={api.classes} studentName={studentName} />}
        {tab === "frequencia" && <Frequencia students={students} checkins={checkins} api={api.checkins} studentName={studentName} />}
        {tab === "relatorios" && <Relatorios students={students} payments={payments} />}
        {tab === "configuracoes" && <Configuracoes settings={settings} onSave={api.settings.save} currentUserId={session.user.id} />}
      </main>
    </div>
  );
}

// ---------- dashboard ----------
function Dashboard({ students, payments, checkins, studentName }) {
  const activeStudents = students.filter((s) => s.status === "ativo");
  const checkinsToday = checkins.filter((c) => c.data === today);
  const overdue = payments.filter((p) => p.status === "atrasado");
  const revenueMonth = payments.filter((p) => p.status === "pago" && p.mesRef === today.slice(0, 7)).reduce((s, p) => s + p.valor, 0);
  const upcoming = payments.filter((p) => p.status !== "pago" && p.vencimento >= today && p.vencimento <= addDays(today, 7)).sort((a, b) => a.vencimento.localeCompare(b.vencimento));
  const stats = [
    { label: "Alunos ativos", value: activeStudents.length, icon: Users },
    { label: "Check-ins hoje", value: checkinsToday.length, icon: Flame },
    { label: "Mensalidades atrasadas", value: overdue.length, icon: AlertTriangle },
    { label: "Receita do mês", value: fmtBRL(revenueMonth), icon: TrendingUp },
  ];
  return (
    <div>
      <Header title="Painel" subtitle={fmtDate(today)} />
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-px rounded-2xl overflow-hidden mb-8" style={{ background: C.sidebarLine }}>
        {stats.map((s) => {
          const Icon = s.icon;
          return (
            <div key={s.label} className="p-5" style={{ background: C.sidebar }}>
              <Icon size={16} color={C.lime} />
              <div style={{ ...fontMono, fontSize: "1.9rem", color: C.lime, lineHeight: 1 }} className="mt-3">{s.value}</div>
              <div className="text-xs mt-2" style={{ color: "#9A9A9E" }}>{s.label}</div>
            </div>
          );
        })}
      </div>
      <div className="grid md:grid-cols-2 gap-6 mb-6">
        <Panel className="p-5">
          <div className="font-semibold mb-4">Check-ins de hoje</div>
          {checkinsToday.length === 0 && <div className="text-sm" style={{ color: C.inkSoft }}>Ninguém fez check-in ainda hoje.</div>}
          <div className="flex flex-col gap-3">
            {checkinsToday.map((c) => (
              <div key={c.id} className="flex items-center gap-3"><Avatar name={studentName(c.studentId)} size={30} /><div className="text-sm flex-1">{studentName(c.studentId)}</div><div className="text-xs" style={fontMono}>{c.hora}</div></div>
            ))}
          </div>
        </Panel>
        <Panel className="p-5">
          <div className="font-semibold mb-4">Mensalidades a vencer (7 dias)</div>
          {upcoming.length === 0 && <div className="text-sm" style={{ color: C.inkSoft }}>Nada vencendo nos próximos dias.</div>}
          <div className="flex flex-col gap-3">
            {upcoming.map((p) => (
              <div key={p.id} className="flex items-center gap-3"><Avatar name={studentName(p.studentId)} size={30} /><div className="text-sm flex-1">{studentName(p.studentId)}</div><Badge tone="amber">vence {fmtDate(p.vencimento)}</Badge></div>
            ))}
          </div>
        </Panel>
      </div>
      {overdue.length > 0 && (
        <Panel className="p-5">
          <div className="font-semibold mb-4 flex items-center gap-2"><AlertTriangle size={15} color={C.red} /> Mensalidades em atraso</div>
          <div className="flex flex-col gap-3">
            {overdue.map((p) => (
              <div key={p.id} className="flex items-center gap-3"><Avatar name={studentName(p.studentId)} size={30} /><div className="text-sm flex-1">{studentName(p.studentId)}</div><Badge tone="red">{fmtBRL(p.valor)}</Badge></div>
            ))}
          </div>
        </Panel>
      )}
    </div>
  );
}

// ---------- alunos ----------
function Alunos({ students, api, payments, checkins }) {
  const [query, setQuery] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ nome: "", telefone: "", plano: "Mensal", matricula: todayISO() });
  const [copiedId, setCopiedId] = useState(null);
  const filtered = students.filter((s) => s.nome.toLowerCase().includes(query.toLowerCase()));

  function addStudent(e) { e.preventDefault(); if (!form.nome.trim()) return; api.add({ ...form, status: "ativo" }); setForm({ nome: "", telefone: "", plano: "Mensal", matricula: todayISO() }); setShowForm(false); }

  async function copyLink(s) {
    if (!s.accessToken) { alert("Esse aluno ainda não tem um link — rode a migração da página do aluno no Supabase (veja o topo do arquivo do app) e recarregue a página."); return; }
    const url = `${window.location.origin}${window.location.pathname}?aluno=${s.accessToken}`;
    try { await navigator.clipboard.writeText(url); setCopiedId(s.id); setTimeout(() => setCopiedId(null), 2000); } catch { alert(url); }
  }

  return (
    <div>
      <Header title="Alunos" subtitle={`${students.length} cadastrados`} action={<PrimaryButton onClick={() => setShowForm((v) => !v)}><Plus size={16} /> Novo aluno</PrimaryButton>} />
      {showForm && (
        <Panel className="p-5 mb-6">
          <form onSubmit={addStudent} className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4 items-end">
            <Field label="Nome completo"><input required style={inputStyle} value={form.nome} onChange={(e) => setForm({ ...form, nome: e.target.value })} placeholder="Ex: Ana Souza" /></Field>
            <Field label="Telefone"><input style={inputStyle} value={form.telefone} onChange={(e) => setForm({ ...form, telefone: e.target.value })} placeholder="(11) 90000-0000" /></Field>
            <Field label="Plano"><select style={inputStyle} value={form.plano} onChange={(e) => setForm({ ...form, plano: e.target.value })}><option>Mensal</option><option>Trimestral</option><option>Anual</option></select></Field>
            <Field label="Data de matrícula"><input type="date" style={inputStyle} value={form.matricula} onChange={(e) => setForm({ ...form, matricula: e.target.value })} /></Field>
            <div className="sm:col-span-2 lg:col-span-4 flex gap-2"><PrimaryButton type="submit"><Check size={16} /> Salvar aluno</PrimaryButton><GhostButton onClick={() => setShowForm(false)}>Cancelar</GhostButton></div>
          </form>
        </Panel>
      )}
      <div className="relative mb-4 max-w-sm"><Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2" color={C.inkSoft} /><input style={{ ...inputStyle, paddingLeft: "2.2rem" }} placeholder="Buscar aluno..." value={query} onChange={(e) => setQuery(e.target.value)} /></div>
      <Panel>
        <div>
          {filtered.map((s) => {
            const totalCheckins = checkins.filter((c) => c.studentId === s.id).length;
            return (
              <div key={s.id} className="flex flex-wrap items-center gap-4 p-4" style={{ borderTop: `1px solid ${C.border}` }}>
                <Avatar name={s.nome} />
                <div className="min-w-[160px]"><div className="font-semibold text-sm">{s.nome}</div><div className="text-xs" style={{ color: C.inkSoft }}>{s.telefone || "sem telefone"}</div></div>
                <Badge tone="neutral">{s.plano}</Badge>
                <div className="text-xs" style={{ color: C.inkSoft }}>desde {fmtDate(s.matricula)}</div>
                <div className="text-xs" style={{ color: C.inkSoft }}>{totalCheckins} check-ins</div>
                <div className="ml-auto flex items-center gap-2">
                  <Badge tone={s.status === "ativo" ? "green" : "neutral"}>{s.status}</Badge>
                  <GhostButton onClick={() => copyLink(s)}><MessageCircle size={13} /> {copiedId === s.id ? "Copiado!" : "Link do aluno"}</GhostButton>
                  <GhostButton onClick={() => api.update(s.id, { status: s.status === "ativo" ? "inativo" : "ativo" })}>{s.status === "ativo" ? "Inativar" : "Reativar"}</GhostButton>
                  <button onClick={() => api.remove(s.id)} className="p-2 rounded-lg" style={{ color: C.red }}><Trash2 size={16} /></button>
                </div>
              </div>
            );
          })}
          {filtered.length === 0 && <div className="p-6 text-sm text-center" style={{ color: C.inkSoft }}>Nenhum aluno encontrado.</div>}
        </div>
      </Panel>
    </div>
  );
}

// ---------- mensalidades ----------
function Mensalidades({ students, payments, api, studentName }) {
  const [filter, setFilter] = useState("todos");
  const [showForm, setShowForm] = useState(false);
  const [copiedId, setCopiedId] = useState(null);
  const [form, setForm] = useState({ studentId: students[0]?.id ?? "", mesRef: today.slice(0, 7), valor: "", vencimento: addDays(today, 10) });
  const filtered = payments.filter((p) => filter === "todos" || p.status === filter);

  function addPayment(e) { e.preventDefault(); if (!form.studentId || !form.valor) return; api.add({ studentId: form.studentId, mesRef: form.mesRef, valor: Number(form.valor), status: "pendente", dataPagamento: null, vencimento: form.vencimento }); setForm({ ...form, valor: "" }); setShowForm(false); }
  function toneFor(status) { if (status === "pago") return "green"; if (status === "atrasado") return "red"; return "amber"; }
  async function copyMessage(p) {
    const msg = `Olá ${studentName(p.studentId)}! Passando para lembrar que sua mensalidade de ${mesLabel(p.mesRef)} (${fmtBRL(p.valor)}) vence em ${fmtDate(p.vencimento)}. Qualquer dúvida, é só chamar 💪`;
    try { await navigator.clipboard.writeText(msg); setCopiedId(p.id); setTimeout(() => setCopiedId(null), 2000); } catch { alert(msg); }
  }
  const totalMes = payments.filter((p) => p.status === "pago").reduce((s, p) => s + p.valor, 0);

  return (
    <div>
      <Header title="Mensalidades" subtitle={`Total recebido: ${fmtBRL(totalMes)}`} action={<PrimaryButton onClick={() => setShowForm((v) => !v)}><Plus size={16} /> Nova cobrança</PrimaryButton>} />
      {showForm && (
        <Panel className="p-5 mb-6">
          <form onSubmit={addPayment} className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4 items-end">
            <Field label="Aluno"><select style={inputStyle} value={form.studentId} onChange={(e) => setForm({ ...form, studentId: e.target.value })}>{students.map((s) => <option key={s.id} value={s.id}>{s.nome}</option>)}</select></Field>
            <Field label="Mês de referência"><input type="month" style={inputStyle} value={form.mesRef} onChange={(e) => setForm({ ...form, mesRef: e.target.value })} /></Field>
            <Field label="Vencimento"><input type="date" style={inputStyle} value={form.vencimento} onChange={(e) => setForm({ ...form, vencimento: e.target.value })} /></Field>
            <Field label="Valor (R$)"><input type="number" min="0" style={inputStyle} value={form.valor} onChange={(e) => setForm({ ...form, valor: e.target.value })} placeholder="120" /></Field>
            <div className="flex gap-2"><PrimaryButton type="submit"><Check size={16} /> Lançar</PrimaryButton><GhostButton onClick={() => setShowForm(false)}>Cancelar</GhostButton></div>
          </form>
        </Panel>
      )}
      <div className="flex gap-2 mb-4 flex-wrap">
        {["todos", "pago", "pendente", "atrasado"].map((f) => (
          <button key={f} onClick={() => setFilter(f)} className="px-3 py-1.5 rounded-full text-xs font-semibold capitalize" style={{ background: filter === f ? C.ink : "transparent", color: filter === f ? "#fff" : C.inkSoft, border: `1px solid ${filter === f ? C.ink : C.border}` }}>{f}</button>
        ))}
      </div>
      <Panel>
        <div>
          {filtered.slice().reverse().map((p) => (
            <div key={p.id} className="flex flex-wrap items-center gap-4 p-4" style={{ borderTop: `1px solid ${C.border}` }}>
              <Avatar name={studentName(p.studentId)} size={32} />
              <div className="min-w-[150px]"><div className="font-semibold text-sm">{studentName(p.studentId)}</div><div className="text-xs" style={{ color: C.inkSoft }}>{mesLabel(p.mesRef)} · vence {fmtDate(p.vencimento)}</div></div>
              <div style={{ ...fontMono, fontWeight: 700 }}>{fmtBRL(p.valor)}</div>
              <Badge tone={toneFor(p.status)}>{p.status}</Badge>
              {p.dataPagamento && <div className="text-xs" style={{ color: C.inkSoft }}>pago em {fmtDate(p.dataPagamento)}</div>}
              <div className="ml-auto flex items-center gap-2">
                {p.status !== "pago" && <button onClick={() => copyMessage(p)} className="text-xs font-medium flex items-center gap-1" style={{ color: C.limeDark }}><MessageCircle size={13} /> {copiedId === p.id ? "Copiado!" : "Copiar lembrete"}</button>}
                {p.status !== "pago" && <GhostButton onClick={() => api.update(p.id, { status: "pago", dataPagamento: todayISO() })}><Check size={14} /> Marcar como pago</GhostButton>}
              </div>
            </div>
          ))}
          {filtered.length === 0 && <div className="p-6 text-sm text-center" style={{ color: C.inkSoft }}>Nenhum lançamento nesse filtro.</div>}
        </div>
      </Panel>
    </div>
  );
}

// ---------- treinos ----------
function Treinos({ students, workouts, api, studentName }) {
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ studentId: students[0]?.id ?? "", nome: "", tipo: "Musculação" });
  const [exercicios, setExercicios] = useState([{ nome: "", series: "" }]);
  function updateExercicio(i, field, value) { setExercicios(exercicios.map((ex, idx) => (idx === i ? { ...ex, [field]: value } : ex))); }
  function addWorkout(e) { e.preventDefault(); if (!form.nome.trim()) return; api.add({ ...form, exercicios: exercicios.filter((ex) => ex.nome.trim()) }); setForm({ studentId: students[0]?.id ?? "", nome: "", tipo: "Musculação" }); setExercicios([{ nome: "", series: "" }]); setShowForm(false); }

  return (
    <div>
      <Header title="Treinos" subtitle={`${workouts.length} planos ativos`} action={<PrimaryButton onClick={() => setShowForm((v) => !v)}><Plus size={16} /> Novo treino</PrimaryButton>} />
      {showForm && (
        <Panel className="p-5 mb-6">
          <form onSubmit={addWorkout} className="flex flex-col gap-4">
            <div className="grid sm:grid-cols-3 gap-4">
              <Field label="Aluno"><select style={inputStyle} value={form.studentId} onChange={(e) => setForm({ ...form, studentId: e.target.value })}>{students.map((s) => <option key={s.id} value={s.id}>{s.nome}</option>)}</select></Field>
              <Field label="Nome do treino"><input required style={inputStyle} value={form.nome} onChange={(e) => setForm({ ...form, nome: e.target.value })} placeholder="Treino A - Superior" /></Field>
              <Field label="Tipo"><select style={inputStyle} value={form.tipo} onChange={(e) => setForm({ ...form, tipo: e.target.value })}><option>Musculação</option><option>Funcional</option><option>Cardio</option><option>Crossfit</option></select></Field>
            </div>
            <div>
              <div className="text-sm font-medium mb-2" style={{ color: C.inkSoft }}>Exercícios</div>
              <div className="flex flex-col gap-2">{exercicios.map((ex, i) => (<div key={i} className="flex gap-2"><input style={{ ...inputStyle, flex: 2 }} placeholder="Ex: Agachamento livre" value={ex.nome} onChange={(e) => updateExercicio(i, "nome", e.target.value)} /><input style={{ ...inputStyle, flex: 1 }} placeholder="4x10" value={ex.series} onChange={(e) => updateExercicio(i, "series", e.target.value)} /></div>))}</div>
              <button type="button" onClick={() => setExercicios([...exercicios, { nome: "", series: "" }])} className="text-xs font-semibold mt-2" style={{ color: C.limeDark }}>+ adicionar exercício</button>
            </div>
            <div className="flex gap-2"><PrimaryButton type="submit"><Check size={16} /> Salvar treino</PrimaryButton><GhostButton onClick={() => setShowForm(false)}>Cancelar</GhostButton></div>
          </form>
        </Panel>
      )}
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
        {workouts.map((w) => (
          <Panel key={w.id} className="p-5 flex flex-col gap-3">
            <div className="flex items-start justify-between"><div><div className="font-semibold text-sm">{w.nome}</div><div className="text-xs" style={{ color: C.inkSoft }}>{studentName(w.studentId)}</div></div><button onClick={() => api.remove(w.id)} style={{ color: C.red }}><Trash2 size={15} /></button></div>
            <Badge tone="neutral">{w.tipo}</Badge>
            <div className="flex flex-col gap-1.5 mt-1">
              {w.exercicios.map((ex, i) => (<div key={i} className="flex justify-between text-sm"><span>{ex.nome}</span><span style={{ ...fontMono, color: C.inkSoft }}>{ex.series}</span></div>))}
              {w.exercicios.length === 0 && <div className="text-xs" style={{ color: C.inkSoft }}>Nenhum exercício adicionado.</div>}
            </div>
          </Panel>
        ))}
        {workouts.length === 0 && <div className="text-sm col-span-full" style={{ color: C.inkSoft }}>Nenhum treino cadastrado ainda.</div>}
      </div>
    </div>
  );
}

// ---------- avaliações ----------
const MEDIDAS_FIELDS = [
  { key: "cintura", label: "Cintura (cm)" },
  { key: "quadril", label: "Quadril (cm)" },
  { key: "braco", label: "Braço (cm)" },
  { key: "coxa", label: "Coxa (cm)" },
  { key: "peito", label: "Peito (cm)" },
];
const METRICS = [
  { key: "peso", label: "Peso (kg)" },
  { key: "imc", label: "IMC" },
  { key: "gordura", label: "% Gordura" },
  { key: "massaMuscular", label: "Massa muscular (kg)" },
];
function calcImc(peso, altura) {
  if (!peso || !altura) return null;
  const m = altura / 100;
  return +(peso / (m * m)).toFixed(1);
}
function imcFaixa(imc) {
  if (imc == null) return null;
  if (imc < 18.5) return { label: "abaixo do peso", tone: "amber" };
  if (imc < 25) return { label: "peso normal", tone: "green" };
  if (imc < 30) return { label: "sobrepeso", tone: "amber" };
  return { label: "obesidade", tone: "red" };
}

function Avaliacoes({ students, evaluations, api }) {
  const [studentId, setStudentId] = useState(students[0]?.id ?? "");
  const [metric, setMetric] = useState("peso");
  const emptyForm = { data: todayISO(), peso: "", altura: "", gordura: "", massaMuscular: "", cintura: "", quadril: "", braco: "", coxa: "", peito: "", obs: "" };
  const [form, setForm] = useState(emptyForm);

  const history = evaluations
    .filter((e) => e.studentId === studentId)
    .sort((a, b) => a.data.localeCompare(b.data))
    .map((e) => ({ ...e, imc: calcImc(e.peso, e.altura) }));

  const chartData = history.map((e) => ({ data: fmtDate(e.data).slice(0, 5), valor: e[metric] }));
  const latestAltura = [...history].reverse().find((e) => e.altura)?.altura ?? "";

  function addEvaluation(e) {
    e.preventDefault();
    if (!studentId || !form.peso) return;
    const medidas = {};
    MEDIDAS_FIELDS.forEach((f) => { if (form[f.key]) medidas[f.key] = Number(form[f.key]); });
    api.add({
      studentId, data: form.data, peso: Number(form.peso),
      altura: form.altura ? Number(form.altura) : (latestAltura || null),
      gordura: form.gordura ? Number(form.gordura) : null,
      massaMuscular: form.massaMuscular ? Number(form.massaMuscular) : null,
      medidas, obs: form.obs,
    });
    setForm(emptyForm);
  }

  return (
    <div>
      <Header title="Avaliações" subtitle="Evolução física dos alunos" />
      <Panel className="p-5 mb-6">
        <div className="grid sm:grid-cols-2 gap-4 mb-4">
          <Field label="Aluno"><select style={inputStyle} value={studentId} onChange={(e) => setStudentId(e.target.value)}>{students.map((s) => <option key={s.id} value={s.id}>{s.nome}</option>)}</select></Field>
          <Field label="Métrica do gráfico">
            <select style={inputStyle} value={metric} onChange={(e) => setMetric(e.target.value)}>
              {METRICS.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
            </select>
          </Field>
        </div>
        {chartData.filter((d) => d.valor != null).length > 1 ? (
          <div style={{ height: 220 }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData}>
                <CartesianGrid stroke={C.border} strokeDasharray="3 3" />
                <XAxis dataKey="data" tick={{ fontSize: 11, fill: C.inkSoft }} />
                <YAxis tick={{ fontSize: 11, fill: C.inkSoft }} width={35} domain={["auto", "auto"]} />
                <Tooltip contentStyle={{ borderRadius: 8, border: `1px solid ${C.border}`, fontSize: 12 }} />
                <Line type="monotone" dataKey="valor" stroke={C.limeDark} strokeWidth={2.5} dot={{ r: 3 }} name={METRICS.find((m) => m.key === metric)?.label} connectNulls />
              </LineChart>
            </ResponsiveContainer>
          </div>
        ) : <div className="text-sm py-8 text-center" style={{ color: C.inkSoft }}>Registre pelo menos 2 avaliações com essa métrica para ver o gráfico.</div>}
      </Panel>

      <Panel className="p-5 mb-6">
        <div className="font-semibold mb-4">Nova avaliação</div>
        <form onSubmit={addEvaluation} className="flex flex-col gap-4">
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <Field label="Data"><input type="date" style={inputStyle} value={form.data} onChange={(e) => setForm({ ...form, data: e.target.value })} /></Field>
            <Field label="Peso (kg)"><input type="number" step="0.1" required style={inputStyle} value={form.peso} onChange={(e) => setForm({ ...form, peso: e.target.value })} placeholder="70" /></Field>
            <Field label={`Altura (cm)${latestAltura ? ` — última: ${latestAltura}` : ""}`}><input type="number" step="1" style={inputStyle} value={form.altura} onChange={(e) => setForm({ ...form, altura: e.target.value })} placeholder={latestAltura ? String(latestAltura) : "175"} /></Field>
            <Field label="% de gordura"><input type="number" step="0.1" style={inputStyle} value={form.gordura} onChange={(e) => setForm({ ...form, gordura: e.target.value })} placeholder="20" /></Field>
            <Field label="Massa muscular (kg)"><input type="number" step="0.1" style={inputStyle} value={form.massaMuscular} onChange={(e) => setForm({ ...form, massaMuscular: e.target.value })} placeholder="32" /></Field>
          </div>
          <div>
            <div className="text-sm font-medium mb-2" style={{ color: C.inkSoft }}>Medidas corporais (opcional)</div>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
              {MEDIDAS_FIELDS.map((f) => (
                <Field key={f.key} label={f.label}><input type="number" step="0.5" style={inputStyle} value={form[f.key]} onChange={(e) => setForm({ ...form, [f.key]: e.target.value })} /></Field>
              ))}
            </div>
          </div>
          <Field label="Observação"><input style={inputStyle} value={form.obs} onChange={(e) => setForm({ ...form, obs: e.target.value })} placeholder="opcional" /></Field>
          <div><PrimaryButton type="submit"><Check size={16} /> Registrar avaliação</PrimaryButton></div>
        </form>
      </Panel>

      <Panel>
        <div>
          {history.slice().reverse().map((e) => {
            const faixa = imcFaixa(e.imc);
            const medidasList = Object.entries(e.medidas || {}).filter(([, v]) => v);
            return (
              <div key={e.id} className="flex flex-wrap items-center gap-3 p-4" style={{ borderTop: `1px solid ${C.border}` }}>
                <div className="text-sm font-semibold min-w-[90px]">{fmtDate(e.data)}</div>
                <div style={{ ...fontMono }}>{e.peso} kg</div>
                {e.altura != null && <div className="text-xs" style={{ color: C.inkSoft }}>{e.altura} cm</div>}
                {e.imc != null && faixa && <Badge tone={faixa.tone}>IMC {e.imc} · {faixa.label}</Badge>}
                {e.gordura != null && <Badge tone="blue">{e.gordura}% gordura</Badge>}
                {e.massaMuscular != null && <Badge tone="neutral">{e.massaMuscular} kg massa musc.</Badge>}
                {medidasList.map(([k, v]) => (
                  <Badge key={k} tone="neutral">{MEDIDAS_FIELDS.find((f) => f.key === k)?.label.split(" ")[0]} {v}cm</Badge>
                ))}
                {e.obs && <div className="text-xs" style={{ color: C.inkSoft }}>{e.obs}</div>}
                <button onClick={() => api.remove(e.id)} className="ml-auto" style={{ color: C.red }}><Trash2 size={15} /></button>
              </div>
            );
          })}
          {history.length === 0 && <div className="p-6 text-sm text-center" style={{ color: C.inkSoft }}>Nenhuma avaliação registrada para este aluno.</div>}
        </div>
      </Panel>
    </div>
  );
}

// ---------- turmas ----------
function Turmas({ students, classes, api, studentName }) {
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ nome: "", horario: "07:00", capacidade: 12, instrutor: "", dias: [] });
  const [enrollFor, setEnrollFor] = useState({});
  function toggleDia(dia) { setForm((f) => ({ ...f, dias: f.dias.includes(dia) ? f.dias.filter((d) => d !== dia) : [...f.dias, dia] })); }
  function addClass(e) { e.preventDefault(); if (!form.nome.trim() || form.dias.length === 0) return; api.add({ ...form, capacidade: Number(form.capacidade), inscritos: [] }); setForm({ nome: "", horario: "07:00", capacidade: 12, instrutor: "", dias: [] }); setShowForm(false); }
  function enroll(c) { const sid = enrollFor[c.id]; if (!sid || c.inscritos.includes(sid) || c.inscritos.length >= c.capacidade) return; api.update(c.id, { inscritos: [...c.inscritos, sid] }); }
  function unenroll(c, sid) { api.update(c.id, { inscritos: c.inscritos.filter((id) => id !== sid) }); }

  return (
    <div>
      <Header title="Turmas" subtitle={`${classes.length} turmas cadastradas`} action={<PrimaryButton onClick={() => setShowForm((v) => !v)}><Plus size={16} /> Nova turma</PrimaryButton>} />
      {showForm && (
        <Panel className="p-5 mb-6">
          <form onSubmit={addClass} className="flex flex-col gap-4">
            <div className="grid sm:grid-cols-4 gap-4">
              <Field label="Nome da turma"><input required style={inputStyle} value={form.nome} onChange={(e) => setForm({ ...form, nome: e.target.value })} placeholder="Funcional Manhã" /></Field>
              <Field label="Horário"><input type="time" style={inputStyle} value={form.horario} onChange={(e) => setForm({ ...form, horario: e.target.value })} /></Field>
              <Field label="Capacidade"><input type="number" min="1" style={inputStyle} value={form.capacidade} onChange={(e) => setForm({ ...form, capacidade: e.target.value })} /></Field>
              <Field label="Instrutor(a)"><input style={inputStyle} value={form.instrutor} onChange={(e) => setForm({ ...form, instrutor: e.target.value })} placeholder="Coach..." /></Field>
            </div>
            <div>
              <div className="text-sm font-medium mb-2" style={{ color: C.inkSoft }}>Dias da semana</div>
              <div className="flex gap-2 flex-wrap">{WEEKDAYS.map((d) => (<button type="button" key={d.id} onClick={() => toggleDia(d.id)} className="px-3 py-1.5 rounded-full text-xs font-semibold" style={{ background: form.dias.includes(d.id) ? C.ink : "transparent", color: form.dias.includes(d.id) ? "#fff" : C.inkSoft, border: `1px solid ${form.dias.includes(d.id) ? C.ink : C.border}` }}>{d.label}</button>))}</div>
            </div>
            <div className="flex gap-2"><PrimaryButton type="submit"><Check size={16} /> Salvar turma</PrimaryButton><GhostButton onClick={() => setShowForm(false)}>Cancelar</GhostButton></div>
          </form>
        </Panel>
      )}
      <div className="grid sm:grid-cols-2 gap-5">
        {classes.map((c) => (
          <Panel key={c.id} className="p-5 flex flex-col gap-3">
            <div className="flex items-start justify-between">
              <div><div className="font-semibold text-sm">{c.nome}</div><div className="text-xs" style={{ color: C.inkSoft }}>{c.dias.map((d) => WEEKDAYS.find((w) => w.id === d)?.label).join(" · ")} às {c.horario}{c.instrutor ? ` · ${c.instrutor}` : ""}</div></div>
              <button onClick={() => api.remove(c.id)} style={{ color: C.red }}><Trash2 size={15} /></button>
            </div>
            <Badge tone={c.inscritos.length >= c.capacidade ? "red" : "green"}>{c.inscritos.length}/{c.capacidade} vagas</Badge>
            <div className="flex flex-col gap-1.5">
              {c.inscritos.map((sid) => (<div key={sid} className="flex items-center gap-2 text-sm"><Avatar name={studentName(sid)} size={24} /><span className="flex-1">{studentName(sid)}</span><button onClick={() => unenroll(c, sid)} className="text-xs" style={{ color: C.inkSoft }}>remover</button></div>))}
              {c.inscritos.length === 0 && <div className="text-xs" style={{ color: C.inkSoft }}>Nenhum aluno inscrito.</div>}
            </div>
            <div className="flex gap-2 mt-1">
              <select style={{ ...inputStyle, flex: 1 }} value={enrollFor[c.id] ?? ""} onChange={(e) => setEnrollFor({ ...enrollFor, [c.id]: e.target.value })}>
                <option value="">Selecionar aluno...</option>
                {students.filter((s) => !c.inscritos.includes(s.id)).map((s) => <option key={s.id} value={s.id}>{s.nome}</option>)}
              </select>
              <GhostButton onClick={() => enroll(c)}>Inscrever</GhostButton>
            </div>
          </Panel>
        ))}
        {classes.length === 0 && <div className="text-sm col-span-full" style={{ color: C.inkSoft }}>Nenhuma turma cadastrada ainda.</div>}
      </div>
    </div>
  );
}

// ---------- frequência ----------
function Frequencia({ students, checkins, api, studentName }) {
  const [studentId, setStudentId] = useState(students[0]?.id ?? "");
  const [fullscreen, setFullscreen] = useState(false);
  const checkinsToday = checkins.filter((c) => c.data === today);
  function registerCheckin() { if (!studentId) return; api.add({ studentId, data: today, hora: new Date().toTimeString().slice(0, 5) }); }
  const totalCounts = useMemo(() => { const map = {}; students.forEach((s) => (map[s.id] = 0)); checkins.forEach((c) => { if (map[c.studentId] !== undefined) map[c.studentId] += 1; }); return map; }, [checkins, students]);

  if (fullscreen) {
    return (
      <div className="fixed inset-0 z-40 flex flex-col items-center justify-center px-6" style={{ background: C.sidebar }}>
        <button onClick={() => setFullscreen(false)} className="absolute top-6 right-6 p-2 rounded-lg" style={{ color: "#9A9A9E" }}><Minimize2 size={20} /></button>
        <div style={{ ...fontDisplay, fontSize: "2.6rem", color: C.lime }}>Check-in</div>
        <div className="text-sm mb-8" style={{ color: "#9A9A9E" }}>{fmtDate(today)}</div>
        <select value={studentId} onChange={(e) => setStudentId(e.target.value)} className="text-lg rounded-xl px-4 py-3 mb-4 w-full max-w-sm" style={{ background: C.sidebarSoft, color: "#fff", border: `1px solid ${C.sidebarLine}` }}>
          {students.filter((s) => s.status === "ativo").map((s) => <option key={s.id} value={s.id}>{s.nome}</option>)}
        </select>
        <button onClick={registerCheckin} className="w-full max-w-sm py-4 rounded-xl text-lg font-bold" style={{ background: C.lime, color: C.ink }}>Registrar entrada</button>
        <div className="mt-10 w-full max-w-sm">
          <div className="text-xs mb-3" style={{ color: "#9A9A9E" }}>últimos check-ins de hoje</div>
          <div className="flex flex-col gap-2">{checkinsToday.slice().reverse().slice(0, 6).map((c) => (<div key={c.id} className="flex items-center gap-3 text-sm" style={{ color: "#E4E4E6" }}><Avatar name={studentName(c.studentId)} size={26} /><span className="flex-1">{studentName(c.studentId)}</span><span style={fontMono}>{c.hora}</span></div>))}</div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <Header title="Frequência" subtitle={`${checkinsToday.length} check-ins hoje · ${fmtDate(today)}`} />
      <Panel className="p-5 mb-6 flex flex-wrap items-end gap-4">
        <Field label="Registrar check-in para"><select style={{ ...inputStyle, minWidth: 220 }} value={studentId} onChange={(e) => setStudentId(e.target.value)}>{students.map((s) => <option key={s.id} value={s.id}>{s.nome}</option>)}</select></Field>
        <PrimaryButton onClick={registerCheckin}><CalendarCheck size={16} /> Registrar check-in</PrimaryButton>
        <GhostButton onClick={() => setFullscreen(true)}><Maximize2 size={14} /> Tela cheia (recepção)</GhostButton>
      </Panel>
      <div className="grid md:grid-cols-2 gap-6">
        <Panel className="p-5">
          <div className="font-semibold mb-4">Check-ins de hoje</div>
          <div className="flex flex-col gap-3">
            {checkinsToday.slice().reverse().map((c) => (<div key={c.id} className="flex items-center gap-3"><Avatar name={studentName(c.studentId)} size={30} /><div className="text-sm flex-1">{studentName(c.studentId)}</div><div className="text-xs" style={fontMono}>{c.hora}</div></div>))}
            {checkinsToday.length === 0 && <div className="text-sm" style={{ color: C.inkSoft }}>Nenhum check-in registrado hoje.</div>}
          </div>
        </Panel>
        <Panel className="p-5">
          <div className="font-semibold mb-4">Total de check-ins por aluno</div>
          <div className="flex flex-col gap-3">{students.map((s) => (<div key={s.id} className="flex items-center gap-3"><Avatar name={s.nome} size={30} /><div className="text-sm flex-1">{s.nome}</div><div style={{ ...fontMono, fontWeight: 700 }}>{totalCounts[s.id] ?? 0}</div></div>))}</div>
        </Panel>
      </div>
    </div>
  );
}

// ---------- relatórios ----------
function Relatorios({ students, payments }) {
  const revenueByMonth = useMemo(() => {
    const map = {};
    payments.filter((p) => p.status === "pago").forEach((p) => { map[p.mesRef] = (map[p.mesRef] || 0) + p.valor; });
    return Object.entries(map).sort(([a], [b]) => a.localeCompare(b)).map(([mesRef, total]) => ({ mes: mesLabel(mesRef), total }));
  }, [payments]);
  const totalPagamentos = payments.length;
  const atrasados = payments.filter((p) => p.status === "atrasado").length;
  const inadimplencia = totalPagamentos ? Math.round((atrasados / totalPagamentos) * 100) : 0;
  const ativos = students.filter((s) => s.status === "ativo").length;
  const inativos = students.length - ativos;
  const retencao = students.length ? Math.round((ativos / students.length) * 100) : 0;

  return (
    <div>
      <Header title="Relatórios" subtitle="Receita, inadimplência e retenção" />
      <Panel className="p-5 mb-6">
        <div className="font-semibold mb-4">Receita mensal (mensalidades pagas)</div>
        {revenueByMonth.length > 0 ? (
          <div style={{ height: 220 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={revenueByMonth}>
                <CartesianGrid stroke={C.border} strokeDasharray="3 3" />
                <XAxis dataKey="mes" tick={{ fontSize: 11, fill: C.inkSoft }} />
                <YAxis tick={{ fontSize: 11, fill: C.inkSoft }} width={40} />
                <Tooltip contentStyle={{ borderRadius: 8, border: `1px solid ${C.border}`, fontSize: 12 }} formatter={(v) => fmtBRL(v)} />
                <Bar dataKey="total" fill={C.limeDark} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        ) : <div className="text-sm py-8 text-center" style={{ color: C.inkSoft }}>Sem pagamentos registrados ainda.</div>}
      </Panel>
      <div className="grid sm:grid-cols-2 gap-6">
        <Panel className="p-5"><div className="font-semibold mb-3">Inadimplência</div><div style={{ ...fontMono, fontSize: "2.2rem", color: inadimplencia > 15 ? C.red : C.ink }}>{inadimplencia}%</div><div className="text-xs mt-1" style={{ color: C.inkSoft }}>{atrasados} de {totalPagamentos} cobranças em atraso</div></Panel>
        <Panel className="p-5"><div className="font-semibold mb-3">Retenção de alunos</div><div style={{ ...fontMono, fontSize: "2.2rem" }}>{retencao}%</div><div className="text-xs mt-1" style={{ color: C.inkSoft }}>{ativos} ativos · {inativos} inativos de {students.length} cadastrados</div></Panel>
      </div>
    </div>
  );
}

// ---------- configurações ----------
function Configuracoes({ settings, onSave, currentUserId }) {
  const [form, setForm] = useState({ nome: settings?.nome || "", telefone: settings?.telefone || "", endereco: settings?.endereco || "", email: settings?.email || "" });
  const [logoUrl, setLogoUrl] = useState(settings?.logoUrl || "");
  const [uploading, setUploading] = useState(false);
  const [saved, setSaved] = useState(false);
  const [accounts, setAccounts] = useState([]);
  const [accountsLoading, setAccountsLoading] = useState(true);
  const [accountsError, setAccountsError] = useState(false);

  useEffect(() => {
    fetchAccounts().then((a) => { setAccounts(a); setAccountsLoading(false); }).catch(() => { setAccountsError(true); setAccountsLoading(false); });
  }, []);

  async function changeRole(id, role) {
    try {
      const updated = await updateAccountRole(id, role);
      setAccounts((prev) => prev.map((a) => (a.id === id ? updated : a)));
    } catch {
      setAccountsError(true);
    }
  }

  async function handleLogoChange(e) {
    const file = e.target.files[0];
    if (!file) return;
    setUploading(true);
    try {
      const url = await uploadLogo(file);
      setLogoUrl(url);
      await onSave({ ...form, logoUrl: url });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch {
      alert("Não foi possível enviar o logo. Confira se o bucket \"logos\" foi criado no Supabase.");
    }
    setUploading(false);
  }

  async function submit(e) {
    e.preventDefault();
    await onSave({ ...form, logoUrl });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  return (
    <div>
      <Header title="Configurações" subtitle="Dados e identidade visual da academia" />
      <Panel className="p-5 mb-6">
        <div className="flex items-center gap-4 mb-6">
          {logoUrl ? (
            <img src={logoUrl} alt="Logo" className="w-16 h-16 rounded-xl object-cover" style={{ border: `1px solid ${C.border}` }} />
          ) : (
            <div className="w-16 h-16 rounded-xl flex items-center justify-center" style={{ background: C.sidebar, color: C.lime, ...fontDisplay, fontSize: "1.4rem" }}>
              {(form.nome || "FERRO").slice(0, 2).toUpperCase()}
            </div>
          )}
          <div>
            <div className="text-sm font-medium mb-1">Logo da academia</div>
            <label className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border cursor-pointer" style={{ borderColor: C.border, color: C.ink }}>
              <Upload size={13} /> {uploading ? "Enviando..." : "Escolher imagem"}
              <input type="file" accept="image/*" onChange={handleLogoChange} disabled={uploading} className="hidden" />
            </label>
          </div>
        </div>
        <form onSubmit={submit} className="grid sm:grid-cols-2 gap-4">
          <Field label="Nome da academia"><input style={inputStyle} value={form.nome} onChange={(e) => setForm({ ...form, nome: e.target.value })} placeholder="Ex: Academia Ferro" /></Field>
          <Field label="Telefone"><input style={inputStyle} value={form.telefone} onChange={(e) => setForm({ ...form, telefone: e.target.value })} placeholder="(11) 90000-0000" /></Field>
          <Field label="E-mail de contato"><input style={inputStyle} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="contato@academia.com" /></Field>
          <Field label="Endereço"><input style={inputStyle} value={form.endereco} onChange={(e) => setForm({ ...form, endereco: e.target.value })} placeholder="Rua, número, bairro" /></Field>
          <div className="sm:col-span-2 flex items-center gap-3">
            <PrimaryButton type="submit"><Check size={16} /> Salvar dados</PrimaryButton>
            {saved && <span className="text-xs" style={{ color: C.limeDark }}>Salvo!</span>}
          </div>
        </form>
      </Panel>
      <Panel className="p-5 mb-6">
        <div className="font-semibold mb-1">Contas de acesso</div>
        <div className="text-xs mb-4" style={{ color: C.inkSoft }}>Quem cria conta pela tela de login entra como "Aguardando aprovação" até você liberar o nível aqui.</div>
        {accountsLoading && <div className="text-sm" style={{ color: C.inkSoft }}>Carregando contas...</div>}
        {accountsError && <div className="text-sm" style={{ color: C.red }}>Não foi possível carregar as contas. Confira se rodou a migração de controle de contas no Supabase.</div>}
        <div className="flex flex-col">
          {accounts.map((a) => {
            const isSelf = a.id === currentUserId;
            return (
              <div key={a.id} className="flex flex-wrap items-center gap-3 py-3" style={{ borderTop: `1px solid ${C.border}` }}>
                <div className="text-sm flex-1 min-w-[160px]">{a.email} {isSelf && <span style={{ color: C.inkSoft }}>(você)</span>}</div>
                <Badge tone={a.role === "dono" ? "green" : a.role === "bloqueado" ? "red" : a.role === "pendente" ? "amber" : "neutral"}>{ROLE_LABELS[a.role] || a.role}</Badge>
                <select
                  disabled={isSelf}
                  style={{ ...inputStyle, width: "auto" }}
                  value={a.role}
                  onChange={(e) => changeRole(a.id, e.target.value)}
                >
                  <option value="pendente">Aguardando aprovação</option>
                  <option value="recepcao">Recepção</option>
                  <option value="instrutor">Instrutor(a)</option>
                  <option value="dono">Dono(a)</option>
                  <option value="bloqueado">Bloqueado</option>
                </select>
              </div>
            );
          })}
          {!accountsLoading && !accountsError && accounts.length === 0 && <div className="text-sm py-2" style={{ color: C.inkSoft }}>Nenhuma conta criada ainda.</div>}
        </div>
        <div className="text-xs mt-4" style={{ color: C.inkSoft }}>
          Para apagar uma conta de vez (não só bloquear), use o painel do Supabase: Authentication → Users → excluir o usuário.
        </div>
      </Panel>

      <div className="text-xs" style={{ color: C.inkSoft }}>
        O nome e o logo aparecem na barra lateral e na tela de login para todos os usuários. Só quem tem perfil "Dono(a)" pode alterar essas configurações.
      </div>
    </div>
  );
}

// ---------- tela de conta pendente/bloqueada ----------
function AccessBlocked({ role, settings }) {
  return (
    <div className="min-h-screen w-full flex items-center justify-center px-6" style={{ background: C.bg, fontFamily: "Inter, sans-serif" }}>
      <div className="text-center max-w-sm">
        <div style={{ ...fontDisplay, fontSize: "1.8rem" }}>{settings?.nome || "FERRO"}</div>
        <div className="font-semibold mt-4 mb-2">{role === "pendente" ? "Conta aguardando aprovação" : "Acesso bloqueado"}</div>
        <div className="text-sm mb-6" style={{ color: C.inkSoft }}>
          {role === "pendente"
            ? "Sua conta foi criada, mas ainda precisa ser liberada por um administrador da academia."
            : "Seu acesso a este sistema foi bloqueado por um administrador da academia."}
        </div>
        <GhostButton onClick={() => supabase.auth.signOut()}><LogOut size={14} /> Sair</GhostButton>
      </div>
    </div>
  );
}

// ---------- página do aluno (sem login, acesso por link privado) ----------
function AlunoPortal({ token }) {
  const [state, setState] = useState({ status: "loading" }); // loading | ok | error
  const [checkinMsg, setCheckinMsg] = useState("");

  async function load() {
    try {
      const { data, error } = await supabase.rpc("get_aluno_portal", { token });
      if (error) throw error;
      if (!data?.student) { setState({ status: "notfound" }); return; }
      setState({ status: "ok", data });
    } catch {
      setState({ status: "error" });
    }
  }

  useEffect(() => { load(); }, [token]);

  async function fazerCheckin() {
    setCheckinMsg("Registrando...");
    try {
      const { error } = await supabase.rpc("aluno_checkin", { token });
      if (error) throw error;
      setCheckinMsg("Check-in registrado! 💪");
      load();
    } catch {
      setCheckinMsg("Não foi possível registrar. Tente de novo.");
    }
    setTimeout(() => setCheckinMsg(""), 3000);
  }

  if (state.status === "loading") {
    return <div className="min-h-screen flex items-center justify-center" style={{ background: C.bg }}><Loader2 className="animate-spin" size={22} color={C.inkSoft} /></div>;
  }
  if (state.status === "notfound" || state.status === "error") {
    return (
      <div className="min-h-screen flex items-center justify-center px-6 text-center" style={{ background: C.bg, fontFamily: "Inter, sans-serif" }}>
        <div>
          <div className="font-semibold mb-2">Link inválido ou expirado</div>
          <div className="text-sm" style={{ color: C.inkSoft }}>Peça para a academia gerar um novo link para você.</div>
        </div>
      </div>
    );
  }

  const { student, payments, workouts, evaluations, checkins } = state.data;
  const sortedEvals = [...evaluations].sort((a, b) => a.data.localeCompare(b.data)).map((e) => ({ ...e, imc: calcImc(e.peso, e.altura) }));
  const chartData = sortedEvals.map((e) => ({ data: fmtDate(e.data).slice(0, 5), peso: e.peso }));
  const checkinsToday = checkins.filter((c) => c.data === today);
  const overdue = payments.filter((p) => p.status === "atrasado");

  return (
    <div className="min-h-screen w-full" style={{ background: C.bg, color: C.ink, fontFamily: "Inter, sans-serif" }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@500;700&display=swap');`}</style>
      <div className="max-w-2xl mx-auto px-5 py-8">
        <div className="mb-6">
          <div style={{ ...fontDisplay, fontSize: "1.8rem", lineHeight: 1 }}>Olá, {student.nome.split(" ")[0]}</div>
          <div className="text-sm mt-1" style={{ color: C.inkSoft }}>{student.plano} · <Badge tone={student.status === "ativo" ? "green" : "neutral"}>{student.status}</Badge></div>
        </div>

        {overdue.length > 0 && (
          <Panel className="p-4 mb-5" style={{ borderColor: C.red }}>
            <div className="flex items-center gap-2 text-sm font-semibold" style={{ color: C.red }}><AlertTriangle size={15} /> Você tem {overdue.length} mensalidade(s) em atraso</div>
          </Panel>
        )}

        <Panel className="p-5 mb-5">
          <div className="flex items-center justify-between mb-2">
            <div className="font-semibold">Check-in</div>
            <div className="text-xs" style={{ color: C.inkSoft }}>{checkinsToday.length > 0 ? "já feito hoje" : "ainda não feito hoje"}</div>
          </div>
          <PrimaryButton onClick={fazerCheckin}><CalendarCheck size={16} /> Fazer check-in agora</PrimaryButton>
          {checkinMsg && <div className="text-xs mt-2" style={{ color: C.limeDark }}>{checkinMsg}</div>}
        </Panel>

        <Panel className="p-5 mb-5">
          <div className="font-semibold mb-3">Mensalidades</div>
          <div className="flex flex-col gap-2">
            {payments.slice().reverse().map((p) => (
              <div key={p.id} className="flex items-center gap-3 text-sm">
                <span className="flex-1">{mesLabel(p.mes_ref)}</span>
                <span style={fontMono}>{fmtBRL(p.valor)}</span>
                <Badge tone={p.status === "pago" ? "green" : p.status === "atrasado" ? "red" : "amber"}>{p.status}</Badge>
              </div>
            ))}
            {payments.length === 0 && <div className="text-sm" style={{ color: C.inkSoft }}>Nenhuma cobrança registrada.</div>}
          </div>
        </Panel>

        <Panel className="p-5 mb-5">
          <div className="font-semibold mb-3">Meus treinos</div>
          <div className="flex flex-col gap-4">
            {workouts.map((w) => (
              <div key={w.id}>
                <div className="text-sm font-semibold">{w.nome} <Badge tone="neutral">{w.tipo}</Badge></div>
                <div className="flex flex-col gap-1 mt-1">
                  {(w.exercicios || []).map((ex, i) => (
                    <div key={i} className="flex justify-between text-sm"><span>{ex.nome}</span><span style={{ ...fontMono, color: C.inkSoft }}>{ex.series}</span></div>
                  ))}
                </div>
              </div>
            ))}
            {workouts.length === 0 && <div className="text-sm" style={{ color: C.inkSoft }}>Nenhum treino cadastrado ainda.</div>}
          </div>
        </Panel>

        <Panel className="p-5">
          <div className="font-semibold mb-3">Minha evolução</div>
          {chartData.length > 1 ? (
            <div style={{ height: 200 }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData}>
                  <CartesianGrid stroke={C.border} strokeDasharray="3 3" />
                  <XAxis dataKey="data" tick={{ fontSize: 11, fill: C.inkSoft }} />
                  <YAxis tick={{ fontSize: 11, fill: C.inkSoft }} width={35} />
                  <Tooltip contentStyle={{ borderRadius: 8, border: `1px solid ${C.border}`, fontSize: 12 }} />
                  <Line type="monotone" dataKey="peso" stroke={C.limeDark} strokeWidth={2.5} dot={{ r: 3 }} name="Peso (kg)" />
                </LineChart>
              </ResponsiveContainer>
            </div>
          ) : <div className="text-sm" style={{ color: C.inkSoft }}>Ainda não há avaliações suficientes para mostrar o gráfico.</div>}
          <div className="flex flex-col gap-2 mt-4">
            {sortedEvals.slice().reverse().map((e) => {
              const faixa = imcFaixa(e.imc);
              return (
                <div key={e.id} className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium min-w-[85px]">{fmtDate(e.data)}</span>
                  <span style={fontMono}>{e.peso} kg</span>
                  {faixa && <Badge tone={faixa.tone}>IMC {e.imc}</Badge>}
                  {e.gordura != null && <Badge tone="blue">{e.gordura}% gordura</Badge>}
                </div>
              );
            })}
          </div>
        </Panel>
      </div>
    </div>
  );
}