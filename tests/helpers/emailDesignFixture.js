// tests/helpers/emailDesignFixture.js
//
// A VALID Designer design for the C3a validator tests (lib/emailDesignRules.js): the shape is
// GrapesJS 0.23.8 + grapesjs-mjml 1.0.8 getProjectData output as the C3 spike recorded it
// (local/c3spike/out/all/q1_project.json — mj-title / mj-preview as type 'text', mj attributes
// mirrored into `style` and `attributes.style`, wrapper head / docEl), the newsletter's sections,
// and the footer slot C3 requires: the LAST mj-section of mj-body, css-class yc-footer, holding
// only the <!-- yc:footer-slot --> comment component.
// The html is the spike's compiled newsletter (newsletter.raw.html) with the footer slot's
// placeholder line replaced by the marker — real MJML output, ~18 KB.
// Each call returns a fresh deep copy: tests mutate it.

'use strict';

const fs = require('fs');
const path = require('path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'emailDesign', 'newsletter.html'), 'utf8');

/** grapesjs-mjml mirrors attributes into style + attributes.style; this builds that shape. */
function mj(type, attrs, components) {
  const style = { ...attrs };
  const attributes = { ...attrs, style: Object.entries(attrs).map(([k, v]) => `${k}:${v};`).join('') };
  const node = { tagName: type, type, style, attributes };
  if (components) node.components = components;
  return node;
}
const text = (s) => ({ type: 'textnode', content: s });

function design() {
  const footerSlot = {
    tagName: 'mj-section', type: 'mj-section',
    style: { 'background-color': '#f9fafb', 'padding-top': '12px', 'padding-bottom': '12px' },
    attributes: { 'css-class': 'yc-footer', 'background-color': '#f9fafb', 'padding-top': '12px', 'padding-bottom': '12px' },
    removable: false, draggable: false, droppable: false, copyable: false, editable: false, stylable: false,
    components: [{
      tagName: 'mj-column', type: 'mj-column', removable: false, draggable: false, droppable: false, copyable: false,
      components: [{
        tagName: 'mj-text', type: 'mj-text', removable: false, draggable: false, droppable: false, copyable: false, editable: false,
        attributes: { align: 'center', 'font-size': '12px' },
        components: [{ type: 'comment', content: ' yc:footer-slot ' }],
      }],
    }],
  };
  return {
    dataSources: [],
    assets: [{ type: 'image', src: 'https://app.4lsg.com/assets/icon-512.png', height: 512, width: 512 }],
    styles: [
      { selectors: [], selectorsAdd: '#outlook a', style: { 'padding-top': '0px' } },
      { selectors: [], selectorsAdd: 'body', style: { 'margin-top': '0px', 'text-size-adjust': '100%' } },
      { selectors: ['mj-column-per-100'], style: { width: '100% !important', 'max-width': '100%' }, mediaText: 'only screen and (min-width: 480px)', atRuleType: 'media' },
    ],
    pages: [{
      id: 'page-1', type: 'main',
      frames: [{
        id: 'frame-1',
        component: {
          type: 'wrapper',
          stylable: ['background', 'background-color'],
          head: { type: 'head' },
          docEl: { tagName: 'html' },
          components: [{
            tagName: 'mjml', type: 'mjml',
            components: [
              {
                tagName: 'mj-head', type: 'mj-head',
                components: [
                  { tagName: 'mj-title', type: 'text', components: [text('4LSG Newsletter')] },
                  { tagName: 'mj-preview', type: 'text', components: [text('Your monthly update from 4LSG, {{contacts.contact_fname|cap}}')] },
                  { tagName: 'mj-attributes', components: [{ tagName: 'mj-all', attributes: { 'font-family': 'Arial, Helvetica, sans-serif' } }, mj('mj-text', { 'font-size': '15px' })] },
                ],
              },
              {
                tagName: 'mj-body', type: 'mj-body', attributes: { 'background-color': '#f3f4f6' },
                components: [
                  mj('mj-section', { 'background-color': '#1e3a5f' }, [
                    mj('mj-column', { 'vertical-align': 'top' }, [
                      mj('mj-image', { src: 'https://app.4lsg.com/assets/icon-512.png', width: '96px', alt: '4LSG', href: 'https://4lsg.com' }),
                      mj('mj-text', { align: 'center', color: '#ffffff' }, [text('Monthly Newsletter')]),
                    ]),
                  ]),
                  mj('mj-section', { 'background-color': '#ffffff', 'background-url': 'https://app.4lsg.com/assets/bg.png' }, [
                    mj('mj-column', { width: '50%' }, [
                      mj('mj-text', {}, [
                        text('Hi {{contacts.contact_fname|cap}}, here is '),
                        { type: 'link', attributes: { href: 'https://4lsg.com/b/consult?c={{contacts.contact_token}}&n={{contacts.contact_fname|cap}}' }, components: [text('a link')] },
                        { tagName: 'p', type: 'text', components: [text('A paragraph with '), { tagName: 'b', components: [text('bold')] }, text('.')] },
                        { tagName: 'ul', components: [{ tagName: 'li', components: [text('one')] }] },
                        { tagName: 'br' },
                        { type: 'link', attributes: { href: '{{send.unsubscribe_url}}' }, components: [text('unsubscribe')] },
                        { type: 'link', attributes: { href: 'mailto:office@4lsg.com' }, components: [text('mail')] },
                      ]),
                    ]),
                    mj('mj-column', { width: '50%' }, [
                      mj('mj-image', { src: 'https://app.4lsg.com/assets/icon-512.png?c={{contacts.contact_token}}', srcset: 'https://x.test/a.png 1x, https://x.test/b.png 2x', alt: 'Right' }),
                      mj('mj-divider', { 'border-color': '#d1d5db' }),
                      mj('mj-spacer', { height: '10px' }),
                    ]),
                  ]),
                  mj('mj-section', { 'background-color': '#ffffff' }, [
                    mj('mj-column', {}, [
                      mj('mj-button', { href: 'https://4lsg.com/b/your-booking-slug?c={{contacts.contact_token}}', 'background-color': '#c2410c' }, [text('Book a free consultation')]),
                      mj('mj-button', { href: 'tel:+12485550100' }, [text('Call {{firm.phone}}')]),
                      mj('mj-button', { href: '#top' }, [text('Top')]),
                    ]),
                  ]),
                  footerSlot,
                ],
              },
            ],
          }],
        },
      }],
    }],
    symbols: [],
  };
}

module.exports = {
  design: () => JSON.parse(JSON.stringify(design())),
  html: () => HTML,
  /** The html's footer-slot section, so a test can rewrite inside it. */
  FOOTER_MARKER_LINE: '><!-- yc:footer-slot --></div>',
};
