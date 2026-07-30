import { Input } from '@librechat/client';
import { Controller, useFormContext } from 'react-hook-form';
import type { AgentForm } from '~/common';
import AgentCategorySelector from '../AgentCategorySelector';
import { useLocalize } from '~/hooks';
import { cn, validateEmail } from '~/utils';

const fieldClass = 'h-9';

export default function PublishingSettings() {
  const localize = useLocalize();
  const {
    control,
    formState: { errors },
  } = useFormContext<AgentForm>();

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col">
        <label
          className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-text-secondary"
          htmlFor="category-selector"
        >
          {localize('com_ui_category')}
        </label>
        <AgentCategorySelector className="w-full rounded-lg" />
      </div>

      <div className="flex flex-col">
        <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-text-secondary">
          {localize('com_ui_support_contact')}
        </label>
        <div className="space-y-2">
          <Controller
            name="support_contact.name"
            control={control}
            rules={{
              minLength: {
                value: 3,
                message: localize('com_ui_support_contact_name_min_length', { minLength: 3 }),
              },
            }}
            render={({ field, fieldState: { error } }) => (
              <div className="flex flex-col">
                <Input
                  {...field}
                  value={field.value ?? ''}
                  className={cn(fieldClass, error && 'border-2 border-red-500')}
                  id="support-contact-name"
                  type="text"
                  placeholder={localize('com_ui_support_contact_name_placeholder')}
                  aria-label={localize('com_ui_support_contact_name')}
                  aria-invalid={error ? 'true' : 'false'}
                  aria-describedby={error ? 'support-contact-name-error' : undefined}
                />
                {error && (
                  <span
                    id="support-contact-name-error"
                    className="mt-1 text-xs text-red-500"
                    role="alert"
                  >
                    {errors.support_contact?.name?.message}
                  </span>
                )}
              </div>
            )}
          />
          <Controller
            name="support_contact.email"
            control={control}
            rules={{
              validate: (value) =>
                validateEmail(value ?? '', localize('com_ui_support_contact_email_invalid')),
            }}
            render={({ field, fieldState: { error } }) => (
              <div className="flex flex-col">
                <Input
                  {...field}
                  value={field.value ?? ''}
                  className={cn(fieldClass, error && 'border-2 border-red-500')}
                  id="support-contact-email"
                  type="email"
                  placeholder={localize('com_ui_support_contact_email_placeholder')}
                  aria-label={localize('com_ui_support_contact_email')}
                  aria-invalid={error ? 'true' : 'false'}
                  aria-describedby={error ? 'support-contact-email-error' : undefined}
                />
                {error && (
                  <span
                    id="support-contact-email-error"
                    className="mt-1 text-xs text-red-500"
                    role="alert"
                  >
                    {errors.support_contact?.email?.message}
                  </span>
                )}
              </div>
            )}
          />
        </div>
      </div>
    </div>
  );
}
