// Feuille de la page de journal « Notion » : la vraie page Notion en cadre (lecture), le lien et les mots-clés (édition).
import { ID, parseNotionUrl, titleFromUrl } from "./data.js";

const { JournalEntryPageHandlebarsSheet } = foundry.applications.sheets.journal;

export class NotionPageSheet extends JournalEntryPageHandlebarsSheet {
  static DEFAULT_OPTIONS = {
    classes: ["wiki-notion-integration", "np-page-sheet"],
    window: { icon: "fa-solid fa-book-open" }
  };

  static EDIT_PARTS = {
    header: super.EDIT_PARTS.header,
    content: { template: `modules/${ID}/templates/page-edit.hbs`, classes: ["standard-form"] },
    footer: super.EDIT_PARTS.footer
  };

  static VIEW_PARTS = {
    content: { template: `modules/${ID}/templates/page-view.hbs`, root: true }
  };

  async _prepareContentContext(context, options) {
    await super._prepareContentContext(context, options);
    const s = this.page.system;
    Object.assign(context, {
      embed: s.embedUrl,
      link: s.publicUrl,
      icon: s.icon,
      keywords: s.keywords,
      imported: !!s.wiki
    });
  }

  // Le champ « Lien » n'existe pas dans les données : on en tire le site et l'identifiant de la page.
  _prepareSubmitData(event, form, formData, updateData) {
    const link = formData.object.link;
    delete formData.object.link;
    if (link !== undefined) {
      const parsed = parseNotionUrl(link);
      if (parsed) {
        formData.object["system.site"] = parsed.site;
        formData.object["system.notionId"] = parsed.id;
        const name = String(formData.object.name ?? "").trim();
        if (!name || name === game.i18n.localize("TYPES.JournalEntryPage.wiki-notion-integration.notion")) {
          formData.object.name = titleFromUrl(link) || name;
        }
      } else if (String(link).trim()) {
        ui.notifications.warn("Wiki Notion Integration : ce lien n'est pas un lien de page Notion (il doit finir par l'identifiant de 32 caractères).");
      }
    }
    return super._prepareSubmitData(event, form, formData, updateData);
  }
}
