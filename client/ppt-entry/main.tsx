import React from 'react';
import { createRoot } from 'react-dom/client';
import PptMaterialsHome from '~/routes/PptMaterialsHome';
import { getPptEntryRedirect } from '~/ppt-entry/routing';

const redirectTarget = getPptEntryRedirect(window.location);

if (redirectTarget) {
  window.location.replace(redirectTarget);
} else {
  const container = document.getElementById('root');
  if (!container) {
    throw new Error('Missing PPT entry root element');
  }

  createRoot(container).render(
    <React.StrictMode>
      <PptMaterialsHome />
    </React.StrictMode>,
  );
}
