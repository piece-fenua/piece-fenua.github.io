/* Pièce Fenua — interface (recherche, comptes, vente, anti-vol, vérification) */
(async () => {
  "use strict";
  const B = await createBackend();
  await B.init();

  // ---------- utilitaires ----------
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
  const prix = n => Number(n).toLocaleString("fr-FR").replace(/ | /g, " ") + " F";
  const norm = s => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const catNom = id => (CATEGORIES.find(c => c.id === id) || {}).nom || id;
  const catIco = id => `<span class="ico-s">${(window.ICONS || {})[id] || "🔧"}</span>`;
  const telDigits = t => String(t || "").replace(/\D/g, "");
  const waLink = t => { const d = telDigits(t); return "https://wa.me/" + (d.length === 8 ? "689" + d : d); };
  const depuis = ts => {
    const h = Math.round((Date.now() - ts) / 3600000);
    if (h < 1) return "à l'instant";
    if (h < 24) return "il y a " + h + " h";
    return "il y a " + Math.round(h / 24) + " j";
  };
  const dateFr = d => d ? new Date(d).toLocaleDateString("fr-FR") : "";
  const JUSTIF = { carte_grise: "Carte grise", ticket: "Ticket / facture d'achat", pv_casse: "Certificat de destruction / achat d'épave" };
  const TYPES = { acheteur: "Acheteur uniquement", particulier: "Particulier (revente d'occasion)", pro: "Magasin / fournisseur professionnel", casse: "Casse / démolisseur" };
  const OFFRES = { gratuit: "Gratuite", partenaire: "Partenaire", premium: "Premium" };
  const MOTIFS = { photo: "Photo inappropriée", vol: "Pièce probablement volée", arnaque: "Arnaque / fausse annonce", autre: "Autre abus" };
  const ID_TYPES = { cni: "Carte d'identité", passeport: "Passeport", permis: "Permis de conduire" };
  const setMsg = (el, txt, ok) => { el.className = "msg " + (ok ? "okm" : "err"); el.textContent = txt; };
  const busy = async (btn, fn) => { btn.disabled = true; try { await fn(); } finally { btn.disabled = false; } };

  // Documents (identité, justificatifs) : image → JPG lisible (1600 px) ; PDF ou format illisible → fichier d'origine
  async function preparerDocument(file) {
    if (!file || !file.type || file.type === "application/pdf") return file;
    try {
      const blob = await compresserPhoto(file, 1600, 0.85);
      const nom = (file.name || "document").replace(/\.[^.]+$/, "") + ".jpg";
      return new File([blob], nom, { type: "image/jpeg" });
    } catch { return file; }
  }

  function compresserPhoto(file, max = 1000, qualite = 0.8) {
    return new Promise((ok, ko) => {
      const img = new Image(), url = URL.createObjectURL(file);
      img.onload = () => {
        const k = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement("canvas");
        c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        c.toBlob(b => b ? ok(b) : ko(new Error("Photo illisible.")), "image/jpeg", qualite);
      };
      img.onerror = () => { URL.revokeObjectURL(url); ko(new Error("Ce fichier n'est pas une image lisible.")); };
      img.src = url;
    });
  }
  const thumb = a => a.photo_url
    ? `<img class="thumb" src="${esc(a.photo_url)}" alt="${esc(a.nom)}" loading="lazy">`
    : `<div class="thumb">${(window.ICONS || {})[a.cat] || ""}</div>`;

  let annonces = [], vols = [], demandes = [], reservations = [], recovery = false;
  const STATUTS_CMD = {
    en_attente: ["⏳ En attente du vendeur", "b-attente"], acceptee: ["✔ Acceptée — à récupérer", "b-verif"],
    refusee: ["✖ Refusée", "b-refus"], terminee: ["✅ Remise au client", "b-neuf"], annulee: ["Annulée", "b-refus"] };
  const user = () => B.user();
  const profil = () => B.profil();
  const profilComplet = () => { const p = profil(); return !!(p && p.nom && p.tel && p.commune); };
  const estVole = serie => { const n = PF_normSerie(serie); return !!n && vols.some(v => PF_normSerie(v.serie) === n); };

  if (B.mode === "demo") { $("#demo-banner").hidden = false; $("#foot-mode").textContent = "Mode démo — vendeurs et prix fictifs."; }

  // ---------- navigation ----------
  const go = view => {
    $$(".tabs button[data-view]").forEach(x => x.classList.toggle("on", x.dataset.view === view));
    // sur mobile, une vue secondaire allume le bouton « Plus »
    $("#btn-plus").classList.toggle("on", ["demande", "vol", "admin"].includes(view));
    fermerPlus();
    $$(".view").forEach(v => v.classList.toggle("on", v.id === "v-" + view));
    render(); window.scrollTo({ top: 0 });
  };
  $$(".tabs button[data-view]").forEach(b => b.addEventListener("click", () => go(b.dataset.view)));
  function fermerPlus() { $("#plus-sheet").hidden = true; $("#btn-plus").setAttribute("aria-expanded", "false"); }
  $("#btn-plus").addEventListener("click", e => {
    e.stopPropagation();
    const ouvert = $("#plus-sheet").hidden;
    $("#plus-sheet").hidden = !ouvert; $("#btn-plus").setAttribute("aria-expanded", String(ouvert));
  });
  $$("#plus-sheet [data-go-view]").forEach(b => b.addEventListener("click", () => go(b.dataset.goView)));
  $("#sheet-lang").addEventListener("click", () => window.PF_setLang && window.PF_setLang(window.PF_LANG === "ty" ? "fr" : "ty"));
  document.addEventListener("click", e => { if (!e.target.closest("#plus-sheet")) fermerPlus(); });
  $("#btn-compte").addEventListener("click", () => go("compte"));

  // ---------- listes déroulantes ----------
  const optsCat = CATEGORIES.map(c => `<option value="${c.id}">${esc(c.nom)}</option>`).join("");
  const optsIle = ILES.map(i => `<option>${esc(i)}</option>`).join("");
  $$(".sel-cat").forEach(s => s.innerHTML = optsCat);
  $$(".sel-ile").forEach(s => s.innerHTML = optsIle);
  $("#f-ile").innerHTML = `<option value="">Toutes les îles</option>` + optsIle;

  // ---------- chargement des données ----------
  async function reload() {
    try {
      [annonces, vols, demandes, reservations] = await Promise.all([
        B.listAnnonces(), user() ? B.listVols() : [], user() ? B.listDemandes() : [],
        user() ? B.listReservations() : []]);
    } catch (e) { console.error(e); }
    render();
  }
  B.onAuth(ev => { if (ev === "PASSWORD_RECOVERY") { recovery = true; go("compte"); } reload(); });

  // ---- lien d'e-mail expiré ou invalide (#error=…&error_code=otp_expired) ----
  let lienErreur = "";
  {
    const h = new URLSearchParams(location.hash.slice(1));
    if (h.get("error") || h.get("error_code")) {
      lienErreur = h.get("error_code") === "otp_expired"
        ? "Ce lien a expiré ou a déjà été utilisé. Seul le dernier e-mail reçu fonctionne, une seule fois. Redemande un lien ci-dessous."
        : "Ce lien n'est pas valable. Redemande un lien ci-dessous.";
      history.replaceState(null, "", location.pathname);
      setTimeout(() => go("compte"), 0);
    }
  }

  // =====================================================================
  //  RECHERCHE
  // =====================================================================
  let catSel = "";
  $("#cats").innerHTML = CATEGORIES.map(c =>
    `<button class="cat" data-cat="${c.id}"><span class="ico">${ICONS[c.id]}</span>${esc(c.nom)}</button>`).join("");
  $$("#cats .cat").forEach(b => b.addEventListener("click", () => {
    catSel = catSel === b.dataset.cat ? "" : b.dataset.cat;
    $$("#cats .cat").forEach(x => x.classList.toggle("on", x.dataset.cat === catSel));
    renderResults();
  }));
  ["#q", "#f-etat", "#f-ile", "#f-stock", "#f-tri"].forEach(s => $(s).addEventListener("input", renderResults));

  function badges(a) {
    let b = "";
    if (a.etat === "neuf") b += `<span class="badge b-neuf">Neuf</span>`;
    else if (a.justif_type) b += `<span class="badge b-verif">✔ Occasion — provenance vérifiée</span>`;
    else b += `<span class="badge b-attente">Occasion — vendeur identifié</span>`;
    if (a.offre === "partenaire" || a.offre === "premium") b += `<span class="badge b-part">⭐ Fournisseur partenaire</span>`;
    if (a.type === "casse") b += `<span class="badge b-neuf">Casse</span>`;
    if (a.type === "particulier") b += `<span class="badge b-neuf">Particulier</span>`;
    return b;
  }
  function stockTxt(a) {
    if (a.qte > 3) return `<span class="ok">● ${a.qte} en stock</span>`;
    if (a.qte > 0) return `<span class="low">● ${a.qte} en stock</span>`;
    return `<span class="no">● ${a.commande ? "Sur commande " + esc(a.commande) : "Rupture"}</span>`;
  }

  // ---- lien direct vers une annonce : …/#a=<id> ----
  let focusId = null;
  const lireHash = () => { const m = location.hash.match(/^#a=([\w-]+)$/); focusId = m ? m[1] : null; };
  lireHash();
  window.addEventListener("hashchange", () => { lireHash(); go("chercher"); });
  const lienAnnonce = a => location.origin + location.pathname + "#a=" + encodeURIComponent(a.id);
  async function partager(a, btn) {
    const url = lienAnnonce(a), texte = `${a.nom} — ${prix(a.prix)} chez ${a.vendeur} (${a.commune}) sur Pièce Fenua`;
    try {
      if (navigator.share) { await navigator.share({ title: a.nom, text: texte, url }); return; }
      await navigator.clipboard.writeText(url);
      btn.textContent = "✔ Lien copié";
    } catch (e) { if (e && e.name !== "AbortError") window.prompt("Copie ce lien :", url); }
  }

  const peutReserver = a => a.qte > 0 && a.owner && !String(a.owner).startsWith("demo-") && a.owner !== user()?.id;

  function renderResults() {
    const q = norm($("#q").value).split(/\s+/).filter(Boolean);
    const etat = $("#f-etat").value, ile = $("#f-ile").value, stock = $("#f-stock").checked, tri = $("#f-tri").value;
    const list = focusId ? annonces.filter(a => a.id === focusId && a.statut === "publie" && !estVole(a.serie)) : annonces.filter(a =>
      a.statut === "publie" && !estVole(a.serie) &&
      (!catSel || a.cat === catSel) && (!etat || a.etat === etat) && (!ile || a.ile === ile) && (!stock || a.qte > 0) &&
      q.every(w => norm([a.nom, a.compat, a.ref, a.vendeur, a.commune, catNom(a.cat)].join(" ")).includes(w)))
      .sort(tri === "prix" ? (x, y) => x.prix - y.prix : (x, y) => y.maj - x.maj)
      .sort((x, y) => (y.offre === "premium") - (x.offre === "premium"));   // premium = à la une

    $("#count").innerHTML = focusId
      ? (list.length ? "Annonce partagée · " : "Cette annonce n'est plus disponible · ") + `<button class="link" id="voir-tout">Voir toutes les pièces</button>`
      : esc(list.length + (list.length > 1 ? " pièces trouvées" : " pièce trouvée"));
    const vt = $("#voir-tout");
    if (vt) vt.onclick = () => { focusId = null; history.replaceState(null, "", location.pathname); renderResults(); };
    $("#results").innerHTML = list.length ? list.map(a => `
      <article class="card has-img${a.offre === "premium" ? " une" : ""}">${a.offre === "premium" ? `<span class="une-tag">À la une</span>` : ""}${thumb(a)}<div class="body">
        <div class="h"><div class="t">${esc(a.nom)}</div><div class="p">${prix(a.prix)}</div></div>
        <div class="m">${esc(a.compat)}${a.ref ? " · Réf. " + esc(a.ref) : ""}</div>
        <div class="m"><b>${esc(a.vendeur)}</b> · ${esc(a.commune)}, ${esc(a.ile)} · ${stockTxt(a)} · mis à jour ${depuis(a.maj)}</div>
        ${badges(a)}
        <div class="actions">
          <a class="btn g" href="${waLink(a.tel)}" target="_blank" rel="noopener">💬 WhatsApp</a>
          <a class="btn b" href="tel:${telDigits(a.tel)}">📞 Appeler</a>
          <button class="btn ghost" data-share="${esc(a.id)}">🔗 Partager</button>
        </div>
        ${peutReserver(a) ? `<button class="btn" data-resa="${esc(a.id)}">🛒 Réserver</button><div class="resa-box"></div>` : ""}
        <button class="link sig" data-sig="${esc(a.id)}">⚑ Signaler cette annonce</button>
        <div class="sig-box"></div>
      </div></article>`).join("")
      : `<div class="empty">Aucune pièce trouvée.<br><br><button class="btn" id="go-demande">📣 Lancer une demande à tous les fournisseurs</button></div>`;
    $$("[data-share]").forEach(b => b.onclick = () => partager(annonces.find(x => x.id === b.dataset.share), b));
    $$("[data-resa]").forEach(b => b.onclick = () => {
      if (!user()) return go("compte");
      const box = b.nextElementSibling, a = annonces.find(x => x.id === b.dataset.resa);
      if (box.innerHTML) { box.innerHTML = ""; return; }
      box.innerHTML = `<form class="form resa-form">
        <div class="two"><label>Quantité<input name="qte" type="number" min="1" max="${a.qte}" value="1" required></label>
        <label>Ton téléphone<input name="tel" inputmode="tel" value="${esc(profil()?.tel || "")}" required></label></div>
        <input name="message" maxlength="300" placeholder="Message au vendeur (facultatif) : jour de passage…">
        <button class="btn">Envoyer la réservation</button><p class="msg"></p></form>`;
      const f = $("form", box);
      f.onsubmit = e => { e.preventDefault();
        busy($("button", f), async () => {
          try {
            await B.reserver(a.id, Number(f.qte.value), f.message.value, f.tel.value);
            box.innerHTML = `<p class="msg okm">✔ Réservation envoyée ! Le vendeur va la confirmer. Suis-la dans l'onglet 🧾 Commandes.</p>`;
            reservations = await B.listReservations(); renderGates();
          } catch (er) { setMsg($(".msg", f), er.message); }
        }); };
    });
    $$("[data-sig]").forEach(b => b.onclick = () => {
      if (!user()) return go("compte");
      const box = b.nextElementSibling;
      if (box.innerHTML) { box.innerHTML = ""; return; }
      box.innerHTML = `<form class="form sig-form">
        <select name="motif">${Object.entries(MOTIFS).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select>
        <input name="details" placeholder="Précisions (facultatif)" maxlength="300">
        <button class="btn red">Envoyer le signalement</button><p class="msg"></p></form>`;
      const f = $("form", box);
      f.onsubmit = e => { e.preventDefault();
        busy($("button", f), async () => {
          try { await B.signaler(b.dataset.sig, f.motif.value, f.details.value); box.innerHTML = `<p class="msg okm">✔ Merci, un modérateur va examiner l'annonce.</p>`; }
          catch (er) { setMsg($(".msg", f), er.message); }
        }); };
    });
    const gd = $("#go-demande");
    if (gd) gd.addEventListener("click", () => {
      go("demande");
      const f = $("#form-demande");
      f.piece.value = $("#q").value; if (catSel) f.cat.value = catSel;
    });
  }

  // =====================================================================
  //  BLOCS « CONNECTE-TOI »
  // =====================================================================
  function gateHtml(txt) {
    return `<div class="gate"><p>${txt}</p><button class="btn b" data-go="compte">👤 Me connecter / créer un compte</button></div>`;
  }
  function renderGates() {
    const logged = !!user();
    $$(".logged-only").forEach(el => el.hidden = !logged);
    $$(".need-login").forEach(el => el.innerHTML = logged ? "" : gateHtml("Connecte-toi pour utiliser cette fonction."));
    $$("[data-go]").forEach(b => b.onclick = () => go(b.dataset.go));
    const p = profil();
    $("#btn-compte").textContent = logged ? "👤 " + (p?.nom || user().email) : "👤 Connexion";
    const nbCmd = user() ? reservations.filter(r => r.vendeur === user().id && r.statut === "en_attente").length : 0;
    const nb = $("#tab-cmd .nb"); nb.hidden = !nbCmd; nb.textContent = nbCmd || "";
    $("#sheet-admin").hidden = !(logged && B.isModerateur()) && B.mode !== "demo";
    $("#tab-admin").hidden = !(logged && B.isModerateur()) && B.mode !== "demo";
  }

  // =====================================================================
  //  COMPTE : inscription, connexion, profil, pièce d'identité
  // =====================================================================
  let sousOnglet = "connexion";
  function renderCompte() {
    const box = $("#compte");
    if (recovery && user()) return renderNouveauMdp(box);
    if (!user()) return renderConnexion(box);
    renderProfil(box);
  }

  function renderConnexion(box) {
    box.innerHTML = `
      <h2>Mon compte</h2>
      ${lienErreur ? `<div class="status st-no">⚠ <div>${esc(lienErreur)}</div></div>` : ""}
      <div class="subtabs">
        <button data-st="connexion" class="${sousOnglet === "connexion" ? "on" : ""}">Se connecter</button>
        <button data-st="inscription" class="${sousOnglet === "inscription" ? "on" : ""}">Créer un compte</button>
      </div>
      ${sousOnglet === "connexion" ? `
      <form id="f-login" class="form">
        <label>E-mail<input name="email" type="email" required autocomplete="email"></label>
        <label>Mot de passe<input name="pw" type="password" required autocomplete="current-password"></label>
        <button class="btn b">Se connecter</button>
        <button type="button" class="link" id="mdp-oublie">Mot de passe oublié ?</button>
        <p class="msg" role="status"></p>
      </form>` : `
      <form id="f-signup" class="form">
        <label>E-mail *<input name="email" type="email" required autocomplete="email"></label>
        <label>Mot de passe * <small>(8 caractères minimum, avec au moins un chiffre)</small>
          <input name="pw" type="password" required minlength="8" autocomplete="new-password"></label>
        <label>Confirme le mot de passe *<input name="pw2" type="password" required autocomplete="new-password"></label>
        <label class="chk"><input type="checkbox" name="consent" required>
          <span>J'accepte la <a href="confidentialite.html" target="_blank">politique de confidentialité</a>. Mes informations servent uniquement au fonctionnement de Pièce Fenua.</span></label>
        <button class="btn">Créer mon compte</button>
        <p class="msg" role="status"></p>
      </form>`}`;

    $$("[data-st]", box).forEach(b => b.onclick = () => { sousOnglet = b.dataset.st; renderCompte(); });

    const fl = $("#f-login", box);
    if (fl) {
      fl.onsubmit = e => { e.preventDefault(); const m = $(".msg", fl);
        busy($("button", fl), async () => {
          try { await B.signIn(fl.email.value, fl.pw.value); await reload(); }
          catch (er) { setMsg(m, er.message); }
        }); };
      $("#mdp-oublie", box).onclick = async () => {
        const m = $(".msg", fl);
        if (!fl.email.value) return setMsg(m, "Écris d'abord ton e-mail.");
        try {
          await B.resetPassword(fl.email.value);
          setMsg(m, B.mode === "demo" ? "En mode démo, aucun e-mail n'est envoyé." : "📧 Un lien pour changer ton mot de passe t'a été envoyé.", true);
        } catch (er) { setMsg(m, er.message); }
      };
    }
    const fs = $("#f-signup", box);
    if (fs) fs.onsubmit = e => {
      e.preventDefault(); const m = $(".msg", fs);
      if (fs.pw.value.length < 8 || !/\d/.test(fs.pw.value)) return setMsg(m, "Mot de passe : 8 caractères minimum, avec au moins un chiffre.");
      if (fs.pw.value !== fs.pw2.value) return setMsg(m, "Les deux mots de passe sont différents.");
      busy($("button.btn", fs), async () => {
        try {
          const r = await B.signUp(fs.email.value, fs.pw.value);
          if (r.needConfirm) { setMsg(m, "📧 Compte créé ! Clique sur le lien reçu par e-mail pour l'activer, puis connecte-toi.", true); fs.reset(); }
          else await reload();
        } catch (er) { setMsg(m, er.message); }
      });
    };
  }

  function renderNouveauMdp(box) {
    box.innerHTML = `<h2>Nouveau mot de passe</h2>
      <form id="f-newpw" class="form">
        <label>Nouveau mot de passe<input name="pw" type="password" required minlength="8" autocomplete="new-password"></label>
        <button class="btn b">Enregistrer</button><p class="msg"></p></form>`;
    const f = $("#f-newpw", box);
    f.onsubmit = async e => { e.preventDefault();
      if (f.pw.value.length < 8 || !/\d/.test(f.pw.value)) return setMsg($(".msg", f), "8 caractères minimum, avec au moins un chiffre.");
      try { await B.updatePassword(f.pw.value); recovery = false; renderCompte(); }
      catch (er) { setMsg($(".msg", f), er.message); } };
  }

  function statutIdHtml(p) {
    switch (p.id_statut) {
      case "verifie": return `<div class="status st-ok">✔ <div><b>Vendeur identifié</b><br>Identité vérifiée le ${dateFr(p.verifie_le)}. Le document a été effacé.</div></div>`;
      case "attente": return `<div class="status st-wait">⏳ <div><b>Vérification en cours</b><br>Tu peux déjà publier : tes annonces d'occasion seront visibles après validation.</div></div>`;
      case "refuse": return `<div class="status st-no">✖ <div><b>Document refusé</b> : ${esc(p.id_motif)}<br>Envoie une nouvelle photo, nette et entière.</div></div>`;
      default: return `<div class="status st-none">🪪 <div>Pas encore envoyée — nécessaire seulement pour <b>revendre</b> des pièces d'occasion.</div></div>`;
    }
  }

  function renderProfil(box) {
    const p = profil(), u = user();
    const peutEnvoyer = ["non_envoye", "refuse"].includes(p.id_statut) && p.type !== "acheteur";
    box.innerHTML = `
      <h2>Mon compte</h2>
      <p class="muted">Connecté : <b>${esc(u.email)}</b></p>
      ${p.suspendu ? `<div class="status st-no">⛔ <div><b>Compte suspendu</b>${p.suspendu_motif ? " : " + esc(p.suspendu_motif) : ""}<br>Tu ne peux plus publier, signaler ni faire de demande. Contacte la modération si tu penses que c'est une erreur.</div></div>` : ""}

      <form id="f-profil" class="form">
        <fieldset><legend>1. Mes informations</legend>
          <label>Type de compte *<select name="type">${Object.entries(TYPES).map(([k, v]) =>
            `<option value="${k}" ${p.type === k ? "selected" : ""}>${v}</option>`).join("")}</select></label>
          <label><span class="lbl-nom">Nom et prénom *</span><input name="nom" required value="${esc(p.nom)}"></label>
          <label class="pro-only">N° Tahiti (entreprise)<input name="ntahiti" value="${esc(p.ntahiti)}" placeholder="ex. A12345"></label>
          <label>Téléphone / WhatsApp *<input name="tel" required inputmode="tel" value="${esc(p.tel)}"></label>
          <div class="two">
            <label>Commune *<input name="commune" required value="${esc(p.commune)}" placeholder="ex. Pirae"></label>
            <label>Île *<select name="ile">${ILES.map(i => `<option ${p.ile === i ? "selected" : ""}>${esc(i)}</option>`).join("")}</select></label>
          </div>
          <button class="btn b">Enregistrer</button>
          <p class="msg" role="status"></p>
        </fieldset>
      </form>

      ${["pro", "casse"].includes(p.type) ? `<div class="status st-none">⭐ <div>Offre actuelle : <b>${OFFRES[p.offre || "gratuit"]}</b>${(p.offre || "gratuit") === "gratuit" ? ` (${PF_LIMITE_GRATUITE} pièces maximum)` : ""}<br><a href="offres.html">Voir les offres pour les professionnels →</a></div></div>` : ""}
      <fieldset class="form" style="margin-top:12px"><legend>2. Pièce d'identité</legend>
        ${statutIdHtml(p)}
        ${peutEnvoyer ? `
        <form id="f-id" class="form">
          <label>Type de document<select name="id_type">${Object.entries(ID_TYPES).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></label>
          <label>Photo du document (recto, lisible) *<input name="file" type="file" accept="image/*,application/pdf" required></label>
          <p class="muted">🔒 Stockée dans un espace privé, visible uniquement par les modérateurs, puis <b>effacée</b> dès la vérification.</p>
          <button class="btn">Envoyer ma pièce d'identité</button>
          <p class="msg" role="status"></p>
        </form>` : p.type === "acheteur" && p.id_statut === "non_envoye" ? `<p class="muted">Choisis un type de compte vendeur pour pouvoir l'envoyer.</p>` : ""}
      </fieldset>

      <div class="actions" style="margin-top:16px">
        <button class="btn ghost" id="logout">Se déconnecter</button>
        <button class="btn red" id="del">Supprimer mon compte</button>
      </div>
      <p class="msg" id="del-msg"></p>`;

    const fp = $("#f-profil", box);
    const majType = () => {
      const pro = ["pro", "casse"].includes(fp.type.value);
      $(".pro-only", fp).hidden = !pro;
      $(".lbl-nom", fp).textContent = pro ? "Nom du commerce *" : "Nom et prénom *";
    };
    fp.type.onchange = majType; majType();
    fp.onsubmit = e => { e.preventDefault(); const m = $(".msg", fp);
      busy($("button", fp), async () => {
        try { await B.saveProfil(Object.fromEntries(new FormData(fp))); renderAll(); setMsg($("#f-profil .msg"), "✔ Profil enregistré.", true); }
        catch (er) { setMsg(m, er.message); }
      }); };

    const fi = $("#f-id", box);
    if (fi) fi.onsubmit = e => { e.preventDefault(); const m = $(".msg", fi);
      const file = fi.file.files[0];
      if (!file) return setMsg(m, "Choisis une photo.");
      if (file.size > 8e6) return setMsg(m, "Fichier trop lourd (8 Mo maximum).");
      if (!profilComplet()) return setMsg(m, "Complète et enregistre d'abord tes informations (étape 1).");
      busy($("button", fi), async () => {
        try { await B.sendId(await preparerDocument(file), fi.id_type.value); renderAll(); }
        catch (er) { setMsg(m, er.message); }
      }); };

    $("#logout", box).onclick = async () => { sousOnglet = "connexion"; await B.signOut(); await reload(); };
    $("#del", box).onclick = async () => {
      const ok = window.prompt("Supprimer définitivement ton compte, tes annonces et tes documents ?\nÉcris SUPPRIMER pour confirmer.");
      if (ok !== "SUPPRIMER") return;
      try { sousOnglet = "connexion"; await B.deleteAccount(); await reload(); }
      catch (er) { setMsg($("#del-msg"), er.message); }
    };
  }

  // =====================================================================
  //  VENDRE
  // =====================================================================
  const fv = $("#form-vendre");
  function renderVendreGate() {
    const gate = $("#vendre-gate"), p = profil();
    let txt = "";
    if (!user()) txt = gateHtml("Connecte-toi pour mettre des pièces en vente.");
    else if (p.suspendu) txt = `<div class="gate"><p>⛔ Ton compte est suspendu : tu ne peux plus vendre.</p></div>`;
    else if (!profilComplet()) txt = `<div class="gate"><p>Complète d'abord ton profil (nom, téléphone, commune).</p><button class="btn b" data-go="compte">Compléter mon profil</button></div>`;
    else if (p.type === "acheteur") txt = `<div class="gate"><p>Ton compte est en mode « acheteur ». Choisis <b>particulier</b>, <b>professionnel</b> ou <b>casse</b> dans ton profil pour vendre.</p><button class="btn b" data-go="compte">Modifier mon profil</button></div>`;
    gate.innerHTML = txt;
    fv.hidden = !!txt;
    $$("[data-go]", gate).forEach(b => b.onclick = () => go(b.dataset.go));
    if (txt) return;
    const nbMes = annonces.filter(a => a.owner === user().id && ["publie", "attente"].includes(a.statut)).length;
    const off = p.offre || "gratuit";
    $("#vendeur-info").innerHTML = `<div class="t">${esc(p.nom)}</div><div class="m">${esc(TYPES[p.type])} · ${esc(p.commune)}, ${esc(p.ile)} · 📞 ${esc(p.tel)}</div>
      <div class="m">Offre ${OFFRES[off]}${off === "gratuit" ? ` : ${nbMes} / ${PF_LIMITE_GRATUITE} pièces en ligne` : " : pièces illimitées"} · <a href="offres.html">Offres pros</a></div>`;
    const optNeuf = fv.etat.querySelector('option[value="neuf"]');
    optNeuf.disabled = p.type === "particulier";
    if (p.type === "particulier") fv.etat.value = "occasion";
    majProvenance();
  }
  function majProvenance() {
    const p = profil(); if (!p) return;
    const occ = fv.etat.value === "occasion";
    $("#provenance").hidden = !occ;
    const gros = Number(fv.prix.value) >= PF_SEUIL;
    $$(".seuil-req").forEach(el => el.hidden = !gros);
    $("#seuil-info").textContent = gros
      ? "À partir de 50 000 F : n° de série et justificatif obligatoires."
      : "Sous 50 000 F : n° de série et justificatif facultatifs.";
    const r = $("#id-rappel");
    if (p.id_statut === "verifie") r.innerHTML = "✔ Ton identité est vérifiée.";
    else if (p.id_statut === "attente") r.innerHTML = "⏳ Identité en cours de vérification : l'annonce sera visible après validation.";
    else r.innerHTML = `<span class="no">🪪 Envoie d'abord ta pièce d'identité dans l'onglet Compte.</span>`;
  }
  fv.etat.addEventListener("change", majProvenance);
  fv.prix.addEventListener("input", majProvenance);
  fv.photo.addEventListener("change", () => {
    const f = fv.photo.files[0], prev = $("#photo-prev");
    if (prev.src) URL.revokeObjectURL(prev.src);
    prev.hidden = !f; if (f) prev.src = URL.createObjectURL(f);
  });

  fv.addEventListener("submit", e => {
    e.preventDefault();
    const msg = $("#vendre-msg"), p = profil();
    const f = Object.fromEntries(new FormData(fv));
    const occ = f.etat === "occasion", gros = Number(f.prix) >= PF_SEUIL;
    const justif = fv.doc_justif.files[0] && fv.doc_justif.files[0].size ? fv.doc_justif.files[0] : null;
    if (occ) {
      if (!["attente", "verifie"].includes(p.id_statut)) return setMsg(msg, "Envoie d'abord ta pièce d'identité dans l'onglet Compte.");
      if (gros && !PF_normSerie(f.serie)) return setMsg(msg, "À partir de 50 000 F, indique le n° de série ou le VIN.");
      if (gros && !justif) return setMsg(msg, "À partir de 50 000 F, ajoute la carte grise ou le ticket / la facture d'achat.");
      if (!fv.honneur.checked) return setMsg(msg, "Coche la déclaration sur l'honneur.");
    }
    busy($("button.btn", fv), async () => {
      try {
        const photo = fv.photo.files[0] ? await compresserPhoto(fv.photo.files[0]) : null;
        const a = await B.addAnnonce({ nom: f.nom, cat: f.cat, compat: f.compat, ref: f.ref, etat: f.etat,
          prix: Number(f.prix), qte: Number(f.qte), serie: occ ? f.serie : "", justif_type: f.justif_type }, occ && justif ? await preparerDocument(justif) : null, photo);
        const txt = {
          publie: "✔ Pièce publiée !",
          attente: "✔ Annonce envoyée. Elle sera visible après vérification (en général sous 24 h).",
          bloque: "⚠ Ce n° de série figure sur la liste des pièces signalées volées. L'annonce est bloquée."
        }[a.statut];
        setMsg(msg, txt, a.statut !== "bloque");
        fv.reset(); $("#photo-prev").hidden = true; await reload(); renderVendreGate();
      } catch (er) { setMsg(msg, er.message); }
    });
  });

  function statutBadge(a) {
    return { publie: `<span class="badge b-verif">✔ En ligne</span>`,
             attente: `<span class="badge b-attente">⏳ En vérification</span>`,
             refuse: `<span class="badge b-refus">✖ Refusée</span>`,
             bloque: `<span class="badge b-vol">🚨 Bloquée — n° signalé volé</span>`,
             masque: `<span class="badge b-vol">⛔ Masquée — compte suspendu</span>` }[a.statut] || "";
  }
  function renderMesAnnonces() {
    const mine = user() ? annonces.filter(a => a.owner === user().id) : [];
    const enCours = id => reservations.filter(r => r.annonce_id === id && ["en_attente", "acceptee"].includes(r.statut)).length;
    $("#mes-annonces").innerHTML = mine.length ? mine.map(a => `
      <div class="card has-img">${thumb(a)}<div class="body">
        <div class="h"><div class="t">${esc(a.nom)}</div><div class="p">${prix(a.prix)}</div></div>
        <div class="m">${a.etat === "neuf" ? "Neuf" : "Occasion"} · ${stockTxt(a)} · mis à jour ${depuis(a.maj)}</div>
        ${statutBadge(a)}${enCours(a.id) ? `<span class="badge b-attente">🧾 ${enCours(a.id)} réservation(s) en cours</span>` : ""}
        ${a.motif ? `<div class="m">Motif : ${esc(a.motif)}</div>` : ""}
        <div class="actions">
          <button class="btn ghost" data-edit="${esc(a.id)}">✏️ Modifier</button>
          ${a.qte > 0 ? `<button class="btn ghost" data-vendu="${esc(a.id)}">✔ Marquer vendue</button>` : ""}
          <button class="btn ghost" data-del="${esc(a.id)}">🗑 Supprimer</button>
        </div>
        <div class="edit-box"></div>
      </div></div>`).join("")
      : `<p class="muted">Tu n'as pas encore de pièce en vente.</p>`;

    const trouve = id => annonces.find(x => x.id === id);
    $$("[data-edit]").forEach(b => b.onclick = () => {
      const a = trouve(b.dataset.edit), box = b.closest(".body").querySelector(".edit-box");
      if (box.innerHTML) { box.innerHTML = ""; return; }
      box.innerHTML = `<form class="form edit-form">
        <div class="two"><label>Prix (F CFP)<input name="prix" type="number" min="0" step="50" value="${a.prix}" required></label>
        <label>Quantité en stock<input name="qte" type="number" min="0" value="${a.qte}" required></label></div>
        <label>Compatible avec<input name="compat" value="${esc(a.compat)}"></label>
        <label>Délai si rupture (ex. « 10 jours »)<input name="commande" value="${esc(a.commande || "")}"></label>
        <button class="btn b">Enregistrer</button><p class="msg"></p></form>`;
      const f = $("form", box);
      f.onsubmit = e => { e.preventDefault();
        busy($("button", f), async () => {
          try { await B.updateAnnonce(a.id, { prix: Number(f.prix.value), qte: Number(f.qte.value), compat: f.compat.value, commande: f.commande.value || null }); await reload(); }
          catch (er) { setMsg($(".msg", f), er.message); }
        }); };
    });
    $$("[data-vendu]").forEach(b => b.onclick = () => busy(b, async () => {
      try { await B.updateAnnonce(b.dataset.vendu, { qte: 0 }); await reload(); } catch (er) { alert(er.message); }
    }));
    $$("[data-del]").forEach(b => b.onclick = () => {
      const a = trouve(b.dataset.del);
      if (!window.confirm(`Supprimer définitivement « ${a.nom} » ?`)) return;
      busy(b, async () => { try { await B.deleteAnnonce(a); await reload(); } catch (er) { alert(er.message); } });
    });
  }

  // =====================================================================
  //  COMMANDES (réservations)
  // =====================================================================
  function carteCommande(r, cote) {
    const [lib, cls] = STATUTS_CMD[r.statut] || [r.statut, "b-neuf"];
    const a = annonces.find(x => x.id === r.annonce_id);
    const autreTel = cote === "vendeur" ? r.tel : a?.tel;
    let actions = "";
    if (cote === "vendeur" && r.statut === "en_attente")
      actions = `<button class="btn g" data-cmd="${esc(r.id)}" data-st="acceptee">✔ Accepter</button>
                 <button class="btn red" data-cmd="${esc(r.id)}" data-st="refusee">✖ Refuser</button>`;
    else if (cote === "vendeur" && r.statut === "acceptee")
      actions = `<button class="btn b" data-cmd="${esc(r.id)}" data-st="terminee">✅ Remise au client</button>
                 <button class="btn ghost" data-cmd="${esc(r.id)}" data-st="annulee">Annuler</button>`;
    else if (cote === "acheteur" && ["en_attente", "acceptee"].includes(r.statut))
      actions = `<button class="btn ghost" data-cmd="${esc(r.id)}" data-st="annulee">Annuler ma réservation</button>`;
    return `<div class="card">
      <div class="h"><div class="t">${esc(r.piece_nom)} × ${r.qte}</div><div class="p">${prix((r.prix || 0) * r.qte)}</div></div>
      <div class="m">${cote === "vendeur" ? `Client : <b>${esc(r.nom)}</b>` : `Vendeur : <b>${esc(a?.vendeur || "—")}</b>${a ? " · " + esc(a.commune) + ", " + esc(a.ile) : ""}`} · ${depuis(r.date)}</div>
      ${r.message ? `<div class="m">💬 « ${esc(r.message)} »</div>` : ""}
      <span class="badge ${cls}">${lib}</span>
      <div class="actions">${actions}
        ${autreTel ? `<a class="btn g" href="${waLink(autreTel)}" target="_blank" rel="noopener">💬 WhatsApp</a>` : ""}</div>
    </div>`;
  }
  function renderCommandes() {
    if (!user()) return;
    const me = user().id;
    const recues = reservations.filter(r => r.vendeur === me), mes = reservations.filter(r => r.acheteur === me);
    $("#cmd-recues").innerHTML = recues.length ? recues.map(r => carteCommande(r, "vendeur")).join("") : `<p class="muted">Aucune commande reçue pour l'instant.</p>`;
    $("#cmd-mes").innerHTML = mes.length ? mes.map(r => carteCommande(r, "acheteur")).join("") : `<p class="muted">Tu n'as pas encore réservé de pièce.</p>`;
    $$("[data-cmd]").forEach(b => b.onclick = () => {
      if (b.dataset.st === "annulee" && !window.confirm("Annuler cette réservation ?")) return;
      busy(b, async () => { try { await B.majReservation(b.dataset.cmd, b.dataset.st); await reload(); } catch (er) { alert(er.message); } });
    });
  }

  // =====================================================================
  //  DEMANDES & VOLS
  // =====================================================================
  $("#form-demande").addEventListener("submit", e => {
    e.preventDefault(); const f = e.target;
    busy($("button", f), async () => {
      try { await B.addDemande(Object.fromEntries(new FormData(f))); f.reset(); setMsg($("#demande-msg"), "✔ Demande envoyée aux fournisseurs.", true); await reload(); }
      catch (er) { setMsg($("#demande-msg"), er.message); }
    });
  });
  function renderDemandes() {
    const nbF = cat => new Set(annonces.filter(a => a.cat === cat && a.statut === "publie").map(a => a.vendeur)).size;
    $("#demandes").innerHTML = demandes.length ? demandes.map(d => `
      <div class="card"><div class="t">${catIco(d.cat)} ${esc(d.piece)}</div>
      <div class="m">${esc(d.vehicule || catNom(d.cat))} · ${esc(d.ile)} · ${depuis(d.date)}</div>
      ${d.mine ? `<span class="badge b-attente">Ma demande — envoyée à ${nbF(d.cat)} fournisseur(s)</span>`
               : `<div class="actions"><a class="btn g" href="${waLink(d.tel)}" target="_blank" rel="noopener">💬 Répondre</a></div>`}
      </div>`).join("")
      : `<p class="muted">Aucune demande pour l'instant.</p>`;
  }

  $("#form-vol").addEventListener("submit", e => {
    e.preventDefault(); const f = e.target;
    busy($("button", f), async () => {
      try {
        const nb = await B.addVol(Object.fromEntries(new FormData(f)));
        f.reset(); setMsg($("#vol-msg"), "✔ Signalement enregistré." + (nb ? ` ${nb} annonce(s) correspondante(s) bloquée(s).` : ""), true);
        await reload();
      } catch (er) { setMsg($("#vol-msg"), er.message); }
    });
  });
  function renderVols() {
    const list = B.mode === "demo" ? vols : vols.filter(v => v.owner === user()?.id);
    $("#vols").innerHTML = list.length ? list.map(v => `
      <div class="card"><div class="t">🚨 ${esc(v.serie)}</div>
      <div class="m">${esc(v.desc)}${v.date ? " · " + esc(v.date) : ""}${v.plainte ? " · Plainte " + esc(v.plainte) : ""}</div></div>`).join("")
      : `<p class="muted">Aucun signalement.</p>`;
  }

  // =====================================================================
  //  VÉRIFICATION (modérateurs)
  // =====================================================================
  async function docHtml(bucket, label, path) {
    if (!path) return `<div>${label} : <span class="no">aucun fichier</span></div>`;
    const url = await B.docUrl(bucket, path);
    if (!url) return `<div>${label} : fichier envoyé (aperçu indisponible en démo)</div>`;
    const lien = `<a href="${esc(url)}" target="_blank" rel="noopener">ouvrir dans un nouvel onglet</a>`;
    if (/\.pdf$/i.test(path)) return `<div>${label} (PDF) : ${lien}<br><iframe class="doc-pdf" src="${esc(url)}" title="${esc(label)}"></iframe></div>`;
    return `<div>${label} : ${lien}<br><img class="doc-img" src="${esc(url)}" alt="${esc(label)}"
      onerror="this.outerHTML='<span class=&quot;muted&quot;>Aperçu impossible pour ce format : utilise « ouvrir ».</span>'"></div>`;
  }
  let adminTick = 0;
  async function renderAdmin() {
    if (!$("#v-admin").classList.contains("on") || !user() && B.mode !== "demo") return;
    const tick = ++adminTick;
    let comptes = [];
    try { comptes = await B.listProfilsAttente(); } catch (e) { console.error(e); }
    const htmlComptes = await Promise.all(comptes.map(async p => `
      <div class="card">
        <div class="t">👤 ${esc(p.nom || "(sans nom)")}</div>
        <div class="m">${esc(TYPES[p.type] || p.type)} · ${esc(p.commune)}, ${esc(p.ile)} · 📞 ${esc(p.tel)}${p.email ? " · " + esc(p.email) : ""}</div>
        <div class="docs"><div><b>Document :</b> ${esc(ID_TYPES[p.id_type] || p.id_type)}</div>${await docHtml("identites", "Pièce d'identité", p.id_path)}</div>
        <div class="actions">
          <button class="btn g" data-pok="${esc(p.id)}">✔ Identité vérifiée</button>
          <button class="btn red" data-pko="${esc(p.id)}">✖ Refuser</button>
        </div>
      </div>`));
    const att = annonces.filter(a => a.statut === "attente");
    const htmlAnn = await Promise.all(att.map(async a => `
      <div class="card">
        <div class="h"><div class="t">${catIco(a.cat)} ${esc(a.nom)}</div><div class="p">${prix(a.prix)}</div></div>
        ${a.photo_url ? `<img class="photo-prev" src="${esc(a.photo_url)}" alt="Photo de la pièce">` : ""}
        <div class="m">${esc(a.vendeur)} (${esc(a.type)}) · ${esc(a.commune)}, ${esc(a.ile)} · 📞 ${esc(a.tel)}</div>
        <div class="docs">
          <div><b>N° série / VIN :</b> ${a.serie ? esc(a.serie) : "non renseigné"}</div>
          ${a.justif_type ? `<div><b>Justificatif :</b> ${esc(JUSTIF[a.justif_type] || a.justif_type)}</div>${await docHtml("justificatifs", "Photo", a.justif_path)}`
                          : `<div><b>Justificatif :</b> aucun → badge « vendeur identifié »</div>`}
        </div>
        ${estVole(a.serie) ? `<div class="alert">🚨 Ce n° correspond à un signalement de vol — ne pas publier, contacter les autorités.</div>` : ""}
        <div class="actions">
          <button class="btn g" data-ok="${esc(a.id)}" ${estVole(a.serie) ? "disabled" : ""}>✔ Publier</button>
          <button class="btn red" data-ko="${esc(a.id)}">✖ Refuser</button>
          <button class="btn ghost" data-susp="${esc(a.owner)}">⛔ Suspendre le vendeur</button>
        </div>
      </div>`));
    // signalements
    let sigs = [], susp = [];
    try { [sigs, susp] = await Promise.all([B.listSignalements(), B.listSuspendus()]); } catch (e) { console.error(e); }
    const htmlSig = sigs.map(sg => {
      const a = annonces.find(x => x.id === sg.annonce_id);
      if (!a) return "";
      return `<div class="card">
        <div class="alert">⚑ ${esc(MOTIFS[sg.motif] || sg.motif)}${sg.details ? " — " + esc(sg.details) : ""}</div>
        <div class="card has-img" style="box-shadow:none;padding:8px 0">${thumb(a)}<div class="body">
          <div class="t">${esc(a.nom)} · ${prix(a.prix)}</div>
          <div class="m">${esc(a.vendeur)} · ${esc(a.commune)}, ${esc(a.ile)} · 📞 ${esc(a.tel)}</div>${statutBadge(a)}</div></div>
        <div class="actions">
          ${a.photo_url ? `<button class="btn ghost" data-rphoto="${esc(a.id)}">🖼 Retirer la photo</button>` : ""}
          <button class="btn red" data-rann="${esc(a.id)}" data-motif="${esc(MOTIFS[sg.motif] || "")}">✖ Retirer l'annonce</button>
          <button class="btn red" data-susp="${esc(a.owner)}" data-motif="${esc(MOTIFS[sg.motif] || "")}">⛔ Suspendre le vendeur</button>
          <button class="btn g" data-classer="${esc(sg.id)}">✔ Classer (rien à signaler)</button>
        </div></div>`;
    });
    let pros = [];
    try { pros = await B.listPros(); } catch (e) { console.error(e); }
    const htmlPros = pros.map(p => `<div class="card"><div class="h"><div class="t">${esc(p.nom || "(sans nom)")}</div>
        <select data-offre="${esc(p.id)}">${Object.entries(OFFRES).map(([k, v]) => `<option value="${k}" ${(p.offre || "gratuit") === k ? "selected" : ""}>${v}</option>`).join("")}</select></div>
        <div class="m">${esc(TYPES[p.type])} · ${esc(p.commune)}, ${esc(p.ile)} · 📞 ${esc(p.tel)}${p.ntahiti ? " · N° Tahiti " + esc(p.ntahiti) : ""}</div></div>`);
    const htmlSusp = susp.map(p => `<div class="card">
        <div class="t">⛔ ${esc(p.nom || "(sans nom)")}</div>
        <div class="m">${esc(p.tel)} · suspendu le ${dateFr(p.suspendu_le)} — ${esc(p.suspendu_motif)}</div>
        <div class="actions"><button class="btn g" data-react="${esc(p.id)}">↺ Réactiver le compte</button></div></div>`);
    if (tick !== adminTick) return;
    $("#admin-signal").innerHTML = htmlSig.join("") || `<p class="empty">Aucun signalement 🌺</p>`;
    $("#admin-susp").innerHTML = htmlSusp.join("") || `<p class="empty">Aucun compte suspendu</p>`;
    $("#admin-pros").innerHTML = htmlPros.join("") || `<p class="empty">Aucun compte professionnel</p>`;
    $$("[data-offre]").forEach(sel => sel.onchange = async () => {
      sel.disabled = true;
      try { await B.definirOffre(sel.dataset.offre, sel.value); } catch (er) { alert(er.message); }
      await reload();
    });
    const sigDe = id => sigs.filter(x => x.annonce_id === id);
    $$("[data-classer]").forEach(b => b.onclick = () => busy(b, async () => { await B.classerSignalement(b.dataset.classer); renderAll(); }));
    $$("[data-rphoto]").forEach(b => b.onclick = () => busy(b, async () => {
      const a = annonces.find(x => x.id === b.dataset.rphoto);
      await B.retirerPhoto(a);
      for (const sg of sigDe(a.id)) await B.classerSignalement(sg.id);
      await reload(); }));
    $$("[data-rann]").forEach(b => b.onclick = () => busy(b, async () => {
      const id = b.dataset.rann;
      await B.modererAnnonce(id, "refuse", "retirée par la modération : " + (b.dataset.motif || "abus"));
      for (const sg of sigDe(id)) await B.classerSignalement(sg.id);
      await reload(); }));
    $$("[data-react]").forEach(b => b.onclick = () => busy(b, async () => { await B.reactiver(b.dataset.react); await reload(); }));
    if (tick !== adminTick) return;
    $("#admin-comptes").innerHTML = htmlComptes.join("") || `<p class="empty">Aucun compte en attente 🌺</p>`;
    $("#admin").innerHTML = htmlAnn.join("") || `<p class="empty">Aucune annonce en attente 🌺</p>`;

    $$("[data-pok]").forEach(b => b.onclick = () => busy(b, async () => {
      await B.modererProfil(comptes.find(p => p.id === b.dataset.pok), true); renderAll(); }));
    $$("[data-pko]").forEach(b => b.onclick = () => busy(b, async () => {
      const motif = window.prompt("Motif du refus :", "document illisible ou non conforme");
      if (motif === null) return;
      await B.modererProfil(comptes.find(p => p.id === b.dataset.pko), false, motif); renderAll(); }));
    $$("[data-ok]").forEach(b => b.onclick = () => busy(b, async () => { await B.modererAnnonce(b.dataset.ok, "publie"); await reload(); }));
    $$("[data-ko]").forEach(b => b.onclick = () => busy(b, async () => {
      const a = annonces.find(x => x.id === b.dataset.ko);
      await B.modererAnnonce(a.id, "refuse", estVole(a.serie) ? "n° de série signalé volé" : "documents non conformes ou illisibles");
      await reload(); }));
    $$("[data-susp]").forEach(b => b.onclick = () => busy(b, async () => {
      const motif = window.prompt("Motif de la suspension (visible par la personne) :", b.dataset.motif || "non-respect des règles");
      if (motif === null) return;
      try {
        await B.suspendre(b.dataset.susp, motif);
        for (const sg of sigs.filter(x => annonces.find(a => a.id === x.annonce_id)?.owner === b.dataset.susp)) await B.classerSignalement(sg.id);
      } catch (er) { alert(er.message); }
      await reload(); }));
  }

  // ---------- rendu global ----------
  function render() {
    renderGates(); renderResults(); renderCompte(); renderVendreGate();
    renderMesAnnonces(); renderCommandes(); renderDemandes(); renderVols(); renderAdmin();
  }
  const renderAll = render;
  await reload();

  // ---------- hors ligne (PWA) ----------
  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
})();
