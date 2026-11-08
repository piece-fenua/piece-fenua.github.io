/* =====================================================================
   Pièce Fenua — couche « serveur »
   - Mode DÉMO     : tout est simulé dans le navigateur (localStorage)
   - Mode SUPABASE : comptes, base de données et documents privés réels
   Les deux modes ont exactement la même interface, utilisée par app.js.
   ===================================================================== */
window.PF_SEUIL = 50000;
window.PF_LIMITE_GRATUITE = 30;   // pièces en ligne avec l'offre gratuite (même valeur que dans schema.sql)
window.PF_normSerie = s => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

window.createBackend = async function () {
  const cfg = window.PF_CONFIG || {};
  if (cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY) {
    try {
      await loadScript("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2");
      return supabaseBackend(cfg);
    } catch (e) {
      console.error("Supabase indisponible, passage en mode démo", e);
    }
  }
  return localBackend();
};

function loadScript(src) {
  return new Promise((ok, ko) => {
    const s = document.createElement("script");
    s.src = src; s.onload = ok; s.onerror = ko;
    document.head.appendChild(s);
  });
}
const safeName = n => String(n || "fichier").normalize("NFD").replace(/[^\w.\-]/g, "_").slice(-60);
const PROFIL_VIDE = { nom: "", tel: "", commune: "", ile: "Tahiti", type: "acheteur", ntahiti: "",
  role: "membre", offre: "gratuit", suspendu: false, id_statut: "non_envoye", id_type: "", id_path: null, id_motif: "", verifie_le: null };

/* =========================== MODE SUPABASE =========================== */
function supabaseBackend(cfg) {
  const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
  let user = null, profil = null;
  const err = e => { if (e) throw new Error(traduire(e.message)); };
  const toApp = a => ({ ...a, maj: new Date(a.maj).getTime() });

  async function chargerProfil() {
    if (!user) { profil = null; return; }
    const { data, error } = await sb.from("profiles").select("*").eq("id", user.id).maybeSingle();
    err(error); profil = data || { ...PROFIL_VIDE, id: user.id };
  }

  return {
    mode: "supabase",
    async init() {
      const { data } = await sb.auth.getSession();
      user = data.session?.user || null;
      await chargerProfil();
    },
    onAuth(cb) {
      sb.auth.onAuthStateChange(async (event, session) => {
        user = session?.user || null;
        await chargerProfil();
        cb(event);
      });
    },
    user: () => user,
    profil: () => profil,
    isModerateur: () => profil?.role === "moderateur",

    async signUp(email, pw) {
      const { data, error } = await sb.auth.signUp({ email, password: pw, options: {
        data: { consent_le: new Date().toISOString() },
        emailRedirectTo: location.origin + location.pathname } });
      err(error);
      return { needConfirm: !data.session };
    },
    async signIn(email, pw) { const { error } = await sb.auth.signInWithPassword({ email, password: pw }); err(error); },
    async signOut() { await sb.auth.signOut(); user = null; profil = null; },
    async resetPassword(email) {
      const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
      err(error);
    },
    async updatePassword(pw) { const { error } = await sb.auth.updateUser({ password: pw }); err(error); },

    async saveProfil(f) {
      const champs = { nom: f.nom, tel: f.tel, commune: f.commune, ile: f.ile, type: f.type, ntahiti: f.ntahiti || null };
      // upsert : crée le profil s'il n'existe pas encore, sinon le met à jour
      const { error } = await sb.from("profiles").upsert({ id: user.id, ...champs }, { onConflict: "id" });
      err(error); await chargerProfil();
    },
    async sendId(file, idType) {
      const path = `${user.id}/id-${Date.now()}-${safeName(file.name)}`;
      const up = await sb.storage.from("identites").upload(path, file, { upsert: false });
      err(up.error);
      const { error } = await sb.from("profiles").update({ id_statut: "attente", id_path: path, id_type: idType }).eq("id", user.id);
      err(error); await chargerProfil();
    },
    async deleteAccount() {
      for (const bucket of ["identites", "justificatifs", "photos"]) {
        const { data } = await sb.storage.from(bucket).list(user.id);
        if (data?.length) await sb.storage.from(bucket).remove(data.map(o => `${user.id}/${o.name}`));
      }
      const { error } = await sb.rpc("supprimer_mon_compte"); err(error);
      await sb.auth.signOut(); user = null; profil = null;
    },

    async listAnnonces() {
      const { data, error } = await sb.from("annonces").select("*").order("maj", { ascending: false }).limit(1000);
      err(error); return (data || []).map(toApp);
    },
    async addAnnonce(a, justifFile, photo) {
      let justif_path = null, photo_url = null;
      if (photo) {
        const pp = `${user.id}/${Date.now()}.jpg`;
        const up = await sb.storage.from("photos").upload(pp, photo, { contentType: "image/jpeg" });
        err(up.error);
        photo_url = sb.storage.from("photos").getPublicUrl(pp).data.publicUrl;
      }
      if (justifFile) {
        justif_path = `${user.id}/justif-${Date.now()}-${safeName(justifFile.name)}`;
        const up = await sb.storage.from("justificatifs").upload(justif_path, justifFile);
        err(up.error);
      }
      const row = { nom: a.nom, cat: a.cat, compat: a.compat, ref: a.ref, etat: a.etat, prix: a.prix, qte: a.qte,
        serie: a.serie || null, justif_type: justif_path ? a.justif_type : null, justif_path, photo_url };
      const { data, error } = await sb.from("annonces").insert(row).select().single();
      err(error); return toApp(data);
    },
    async modererAnnonce(id, statut, motif) {
      const { error } = await sb.from("annonces").update({ statut, motif: motif || null }).eq("id", id); err(error);
    },
    async docUrl(bucket, path) {
      if (!path) return null;
      const { data } = await sb.storage.from(bucket).createSignedUrl(path, 300);
      return data?.signedUrl || null;
    },
    async listProfilsAttente() {
      const { data, error } = await sb.from("profiles").select("*").eq("id_statut", "attente").order("created_at");
      err(error); return data || [];
    },
    async modererProfil(p, ok, motif) {
      if (p.id_path) await sb.storage.from("identites").remove([p.id_path]); // le document n'est pas conservé
      const champs = ok
        ? { id_statut: "verifie", verifie_le: new Date().toISOString(), verifie_par: user.id, id_path: null, id_motif: null }
        : { id_statut: "refuse", id_path: null, id_motif: motif || "document illisible ou non conforme" };
      const { error } = await sb.from("profiles").update(champs).eq("id", p.id); err(error);
    },



    // ---- mes pièces ----
    async updateAnnonce(id, champs) {
      const { error } = await sb.from("annonces").update(champs).eq("id", id); err(error);
    },
    async changerPhoto(a, photo) {
      let photo_url = null;
      if (photo) {
        const pp = `${user.id}/${Date.now()}.jpg`;
        const up = await sb.storage.from("photos").upload(pp, photo, { contentType: "image/jpeg" });
        err(up.error);
        photo_url = sb.storage.from("photos").getPublicUrl(pp).data.publicUrl;
      }
      const { error } = await sb.from("annonces").update({ photo_url }).eq("id", a.id); err(error);
      const ancien = String(a.photo_url || "").split("/object/public/photos/")[1];
      if (ancien) await sb.storage.from("photos").remove([decodeURIComponent(ancien)]);
    },
    async deleteAnnonce(a) {
      const m = String(a.photo_url || "").split("/object/public/photos/")[1];
      if (m) await sb.storage.from("photos").remove([decodeURIComponent(m)]);
      if (a.justif_path) await sb.storage.from("justificatifs").remove([a.justif_path]);
      const { error } = await sb.from("annonces").delete().eq("id", a.id); err(error);
    },
    // ---- réservations / commandes ----
    async reserver(annonceId, qte, message, tel) {
      const { error } = await sb.from("reservations").insert({ annonce_id: annonceId, qte, message: message || null, tel: tel || null });
      err(error);
    },
    async listReservations() {
      if (!user) return [];
      const { data, error } = await sb.from("reservations").select("*").order("created_at", { ascending: false }).limit(300);
      err(error); return (data || []).map(r => ({ ...r, date: new Date(r.created_at).getTime() }));
    },
    async majReservation(id, statut) {
      const { error } = await sb.from("reservations").update({ statut }).eq("id", id); err(error);
    },
    // ---- signalements & suspension ----
    async signaler(annonceId, motif, details) {
      const { error } = await sb.from("signalements").insert({ annonce_id: annonceId, motif, details: details || null }); err(error);
    },
    async listSignalements() {
      const { data, error } = await sb.from("signalements").select("*").eq("traite", false).order("created_at");
      err(error); return data || [];
    },
    async classerSignalement(id) { const { error } = await sb.from("signalements").update({ traite: true }).eq("id", id); err(error); },
    async retirerPhoto(a) {
      const m = String(a.photo_url || "").split("/object/public/photos/")[1];
      if (m) await sb.storage.from("photos").remove([decodeURIComponent(m)]);
      const { error } = await sb.from("annonces").update({ photo_url: null }).eq("id", a.id); err(error);
    },
    async suspendre(uid, motif) { const { error } = await sb.rpc("suspendre_compte", { cible: uid, motif }); err(error); },
    async reactiver(uid) { const { error } = await sb.rpc("reactiver_compte", { cible: uid }); err(error); },
    async listPros() {
      const { data, error } = await sb.from("profiles").select("*").in("type", ["pro", "casse"]).order("nom");
      err(error); return data || [];
    },
    async definirOffre(uid, offre) { const { error } = await sb.rpc("definir_offre", { cible: uid, o: offre }); err(error); },
    async listSuspendus() {
      const { data, error } = await sb.from("profiles").select("*").eq("suspendu", true).order("suspendu_le", { ascending: false });
      err(error); return data || [];
    },
    async addVol(v) {
      const { error } = await sb.from("vols").insert({ serie: v.serie, descr: v.desc, date_vol: v.date || null,
        plainte: v.plainte || null, tel: v.tel }); err(error);
      const { data } = await sb.rpc("nb_annonces_serie", { s: v.serie });
      return data || 0;
    },
    async listVols() {
      const { data, error } = await sb.from("vols").select("*").order("created_at", { ascending: false });
      err(error); return (data || []).map(v => ({ ...v, desc: v.descr, date: v.date_vol }));
    },
    async addDemande(d) {
      const { error } = await sb.from("demandes").insert({ piece: d.piece, cat: d.cat, vehicule: d.vehicule, ile: d.ile, tel: d.tel });
      err(error);
    },
    async listDemandes() {
      const { data, error } = await sb.from("demandes").select("*").order("created_at", { ascending: false }).limit(200);
      err(error); return (data || []).map(d => ({ ...d, date: new Date(d.created_at).getTime(), mine: d.owner === user?.id }));
    }
  };
}

function traduire(m) {
  const t = {
    "Invalid login credentials": "E-mail ou mot de passe incorrect.",
    "Email not confirmed": "Confirme d'abord ton adresse e-mail (regarde ta boîte mail).",
    "User already registered": "Un compte existe déjà avec cet e-mail.",
    "Password should be at least 6 characters": "Le mot de passe est trop court."
  };
  for (const k in t) if (m.includes(k)) return t[k];
  return m;
}

/* ============================= MODE DÉMO ============================= */
function localBackend() {
  const mem = {};
  const get = (k, d) => { try { const v = localStorage.getItem("pf2_" + k); return v ? JSON.parse(v) : d; } catch { return k in mem ? mem[k] : d; } };
  const set = (k, v) => { mem[k] = v; try { localStorage.setItem("pf2_" + k, JSON.stringify(v)); return true; } catch { return false; } };

  let users = get("users", []);            // { id, email, salt, hash }
  let profils = get("profils", {});        // id -> profil
  let files = get("files", {});            // chemin -> dataURL (démo uniquement)
  let annonces = get("annonces", null) || DEMO_ANNONCES.map(a => ({ ...a }));
  let vols = get("vols", null) || DEMO_VOLS.map(v => ({ ...v }));
  let demandes = get("demandes", []);
  let signalements = get("signalements", []);
  let reservations = get("reservations", []);
  // en démo, les annonces d'exemple sans propriétaire reçoivent un propriétaire fictif (pour tester la suspension)
  annonces.forEach(a => { if (!a.owner) a.owner = "demo-" + a.tel; });
  let session = get("session", null);
  let cb = () => {};
  const saveAll = () => { set("users", users); set("profils", profils); set("annonces", annonces); set("vols", vols); set("demandes", demandes); set("session", session); };

  async function hash(salt, pw) {
    try {
      const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(salt + pw));
      return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
    } catch { let h = 0; for (const c of salt + pw) h = (h * 31 + c.charCodeAt(0)) | 0; return "x" + h; }
  }
  const uid = () => "u" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const user = () => session ? users.find(u => u.id === session) || null : null;
  const profil = () => user() ? (profils[user().id] ||= { ...PROFIL_VIDE, id: user().id }) : null;
  const lireFichier = file => new Promise(res => {
    if (!file.type.startsWith("image/") || file.size > 1.5e6) return res(null);
    const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => res(null); r.readAsDataURL(file);
  });
  async function stocker(file, prefix) {
    const path = `${user().id}/${prefix}-${Date.now()}-${safeName(file.name)}`;
    const data = await lireFichier(file);
    files[path] = data || "";
    if (!set("files", files)) { files[path] = ""; set("files", files); }
    return path;
  }
  const estVole = s => { const n = PF_normSerie(s); return !!n && vols.some(v => PF_normSerie(v.serie) === n); };
  const fail = m => { throw new Error(m); };

  return {
    mode: "demo",
    async init() {},
    onAuth(f) { cb = f; },
    user, profil,
    isModerateur: () => true,   // en démo, tout le monde peut tester l'espace Vérification

    async signUp(email, pw) {
      email = email.trim().toLowerCase();
      if (users.some(u => u.email === email)) fail("Un compte existe déjà avec cet e-mail.");
      const salt = uid();
      const u = { id: uid(), email, salt, hash: await hash(salt, pw) };
      users.push(u);
      profils[u.id] = { ...PROFIL_VIDE, id: u.id, consent_le: new Date().toISOString() };
      session = u.id; saveAll(); cb("SIGNED_IN");
      return { needConfirm: false };
    },
    async signIn(email, pw) {
      const u = users.find(x => x.email === email.trim().toLowerCase());
      if (!u || u.hash !== await hash(u.salt, pw)) fail("E-mail ou mot de passe incorrect.");
      session = u.id; saveAll(); cb("SIGNED_IN");
    },
    async signOut() { session = null; saveAll(); cb("SIGNED_OUT"); },
    async resetPassword() { /* en démo : pas d'envoi d'e-mail */ },
    async updatePassword(pw) { const u = user(); u.salt = uid(); u.hash = await hash(u.salt, pw); saveAll(); },

    async saveProfil(f) {
      Object.assign(profil(), { nom: f.nom, tel: f.tel, commune: f.commune, ile: f.ile, type: f.type, ntahiti: f.ntahiti || "" });
      saveAll();
    },
    async sendId(file, idType) {
      const p = profil();
      if (!["non_envoye", "refuse"].includes(p.id_statut)) fail("Pièce d'identité déjà envoyée.");
      Object.assign(p, { id_path: await stocker(file, "id"), id_type: idType, id_statut: "attente", id_motif: "" });
      saveAll();
    },
    async deleteAccount() {
      const id = user().id;
      Object.keys(files).filter(k => k.startsWith(id + "/")).forEach(k => delete files[k]);
      annonces = annonces.filter(a => a.owner !== id);
      demandes = demandes.filter(d => d.owner !== id);
      users = users.filter(u => u.id !== id); delete profils[id];
      session = null; set("files", files); saveAll(); cb("SIGNED_OUT");
    },

    async listAnnonces() {
      const me = user()?.id;
      return annonces.filter(a => a.statut === "publie" || a.owner === me || this.isModerateur());
    },
    async addAnnonce(a, justifFile, photo) {
      const p = profil();
      // mêmes règles que le serveur (schema.sql)
      if (p.suspendu) fail("Compte suspendu : " + (p.suspendu_motif || "contacte la modération"));
      if (!p.nom || !p.tel) fail("Complète ton profil avant de vendre.");
      if (p.type === "acheteur") fail("Choisis un type de compte vendeur dans ton profil.");
      const offre = p.offre || "gratuit";
      if (offre === "gratuit" && annonces.filter(x => x.owner === user().id && ["publie", "attente"].includes(x.statut)).length >= PF_LIMITE_GRATUITE)
        fail(`Limite de ${PF_LIMITE_GRATUITE} pièces de l'offre gratuite atteinte : découvre les offres pros.`);
      const n = { ...a, id: "a" + Date.now(), owner: user().id, vendeur: p.nom, tel: p.tel, commune: p.commune,
        ile: p.ile, type: p.type, ntahiti: p.ntahiti, offre, maj: Date.now(), motif: "" };
      if (a.etat === "neuf") {
        if (p.type === "particulier") fail("Un particulier ne peut vendre que de l'occasion.");
        n.statut = "publie";
      } else {
        if (!["attente", "verifie"].includes(p.id_statut)) fail("Envoie ta pièce d'identité (onglet Compte) avant de revendre.");
        if (a.prix >= PF_SEUIL && (!PF_normSerie(a.serie) || !justifFile)) fail("À partir de 50 000 F : n° de série et justificatif obligatoires.");
        n.justif_path = justifFile ? await stocker(justifFile, "justif") : null;
        if (!justifFile) n.justif_type = "";
        if (estVole(a.serie)) { n.statut = "bloque"; n.motif = "n° de série signalé volé"; }
        else n.statut = (a.prix >= PF_SEUIL || p.id_statut !== "verifie") ? "attente" : "publie";
      }
      if (photo) n.photo_url = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.onerror = () => r(null); fr.readAsDataURL(photo); });
      annonces.unshift(n);
      if (!set("annonces", annonces)) { n.photo_url = null; saveAll(); }  // mémoire du téléphone pleine
      else saveAll();
      return n;
    },
    async modererAnnonce(id, statut, motif) {
      const a = annonces.find(x => x.id === id); a.statut = statut; a.motif = motif || ""; a.maj = Date.now(); saveAll();
    },
    async docUrl(bucket, path) { return path ? files[path] || null : null; },
    async listProfilsAttente() {
      return Object.values(profils).filter(p => p.id_statut === "attente")
        .map(p => ({ ...p, email: users.find(u => u.id === p.id)?.email }));
    },
    async modererProfil(pp, ok, motif) {
      const p = profils[pp.id];
      if (p.id_path) { delete files[p.id_path]; set("files", files); }   // le document n'est pas conservé
      if (ok) Object.assign(p, { id_statut: "verifie", verifie_le: new Date().toISOString(), verifie_par: user()?.id, id_path: null, id_motif: "" });
      else Object.assign(p, { id_statut: "refuse", id_path: null, id_motif: motif || "document illisible ou non conforme" });
      saveAll();
    },



    // ---- mes pièces ----
    async updateAnnonce(id, champs) {
      const a = annonces.find(x => x.id === id);
      if (!a || a.owner !== user()?.id) fail("Accès refusé.");
      if (a.etat === "occasion" && champs.prix >= PF_SEUIL && a.prix < PF_SEUIL && (!PF_normSerie(a.serie) || !a.justif_path))
        fail("À partir de 50 000 F : n° de série et justificatif obligatoires. Crée une nouvelle annonce.");
      Object.assign(a, champs, { maj: Date.now() });
      saveAll();
    },
    async changerPhoto(a, photo) {
      const x = annonces.find(y => y.id === a.id);
      if (!x || x.owner !== user()?.id) fail("Accès refusé.");
      x.photo_url = photo ? await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.onerror = () => r(null); fr.readAsDataURL(photo); }) : null;
      x.maj = Date.now();
      if (!set("annonces", annonces)) { x.photo_url = null; saveAll(); fail("Mémoire du téléphone pleine : photo non enregistrée."); }
      saveAll();
    },
    async deleteAnnonce(a) { annonces = annonces.filter(x => x.id !== a.id); reservations = reservations.filter(r => r.annonce_id !== a.id); saveAll(); },
    // ---- réservations / commandes ----
    async reserver(annonceId, qte, message, tel) {
      const a = annonces.find(x => x.id === annonceId), p = profil();
      if (!a || a.statut !== "publie") fail("Cette pièce n'est plus disponible.");
      if (!a.owner || String(a.owner).startsWith("demo-")) fail("Ce vendeur ne prend pas de réservation : contacte-le directement.");
      if (a.owner === user().id) fail("Tu ne peux pas réserver ta propre pièce.");
      if (p?.suspendu) fail("Compte suspendu.");
      if (qte > a.qte) fail(`Stock insuffisant : ${a.qte} disponible(s).`);
      reservations.unshift({ id: "r" + Date.now(), annonce_id: a.id, acheteur: user().id, vendeur: a.owner, qte, message,
        nom: p?.nom || "Client", tel: tel || p?.tel, piece_nom: a.nom, prix: a.prix, statut: "en_attente", date: Date.now() });
      set("reservations", reservations);
    },
    async listReservations() {
      const me = user()?.id; if (!me) return [];
      return reservations.filter(r => r.acheteur === me || r.vendeur === me);
    },
    async majReservation(id, statut) {
      const r = reservations.find(x => x.id === id), me = user()?.id;
      const ok = (me === r.vendeur && ((r.statut === "en_attente" && ["acceptee", "refusee"].includes(statut)) || (r.statut === "acceptee" && ["terminee", "annulee"].includes(statut))))
              || (me === r.acheteur && ["en_attente", "acceptee"].includes(r.statut) && statut === "annulee");
      if (!ok) fail("Changement de statut impossible.");
      r.statut = statut;
      if (statut === "terminee") { const a = annonces.find(x => x.id === r.annonce_id); if (a) a.qte = Math.max(0, a.qte - r.qte); }
      saveAll(); set("reservations", reservations);
    },
    // ---- signalements & suspension ----
    async signaler(annonceId, motif, details) {
      if (profil()?.suspendu) fail("Compte suspendu.");
      signalements.push({ id: "s" + Date.now(), annonce_id: annonceId, owner: user()?.id, motif, details, traite: false, created_at: Date.now() });
      set("signalements", signalements);
    },
    async listSignalements() { return signalements.filter(s => !s.traite && annonces.some(a => a.id === s.annonce_id)); },
    async classerSignalement(id) { const s = signalements.find(x => x.id === id); if (s) s.traite = true; set("signalements", signalements); },
    async retirerPhoto(a) { const x = annonces.find(y => y.id === a.id); x.photo_url = null; saveAll(); },
    async suspendre(uid, motif) {
      if (uid && uid === user()?.id) fail("Tu ne peux pas te suspendre toi-même.");
      const p = profils[uid] || (profils[uid] = { ...PROFIL_VIDE, id: uid, nom: annonces.find(a => a.owner === uid)?.vendeur || "Vendeur" });
      Object.assign(p, { suspendu: true, suspendu_motif: motif, suspendu_le: new Date().toISOString() });
      annonces.forEach(a => { if (a.owner === uid && ["publie", "attente"].includes(a.statut)) { a.statut = "masque"; a.motif = "compte suspendu"; } });
      saveAll();
    },
    async reactiver(uid) {
      const p = profils[uid]; if (p) Object.assign(p, { suspendu: false, suspendu_motif: null, suspendu_le: null });
      annonces.forEach(a => { if (a.owner === uid && a.statut === "masque") { a.statut = "attente"; a.motif = ""; } });
      saveAll();
    },
    async listSuspendus() { return Object.values(profils).filter(p => p.suspendu); },
    async listPros() { return Object.values(profils).filter(p => ["pro", "casse"].includes(p.type)); },
    async definirOffre(uid, offre) {
      profils[uid].offre = offre;
      annonces.forEach(a => { if (a.owner === uid) a.offre = offre; });
      saveAll();
    },
    async addVol(v) {
      if (profil()?.suspendu) fail("Compte suspendu.");
      vols.unshift({ ...v, owner: user()?.id });
      const n = PF_normSerie(v.serie); let nb = 0;
      annonces.forEach(a => { if (n && PF_normSerie(a.serie) === n) { a.statut = "bloque"; a.motif = "n° de série signalé volé"; nb++; } });
      saveAll(); return nb;
    },
    async listVols() { return vols; },
    async addDemande(d) { if (profil()?.suspendu) fail("Compte suspendu."); demandes.unshift({ ...d, owner: user()?.id, date: Date.now() }); saveAll(); },
    async listDemandes() { const me = user()?.id; return demandes.map(d => ({ ...d, mine: d.owner === me })); }
  };
}
