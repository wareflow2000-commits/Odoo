ALTER POLICY system_settings_manager_insert ON public.system_settings
 WITH CHECK (public.current_user_has_permission('action:settings:manage'));
ALTER POLICY system_settings_manager_update ON public.system_settings
 USING (public.current_user_has_permission('action:settings:manage'))
 WITH CHECK (public.current_user_has_permission('action:settings:manage'));
ALTER POLICY system_settings_manager_delete ON public.system_settings
 USING (public.current_user_has_permission('action:settings:manage'));

ALTER POLICY units_manager_insert ON public.units
 WITH CHECK (public.current_user_has_permission('action:settings:manage'));
ALTER POLICY units_manager_update ON public.units
 USING (public.current_user_has_permission('action:settings:manage'))
 WITH CHECK (public.current_user_has_permission('action:settings:manage'));
ALTER POLICY units_manager_delete ON public.units
 USING (public.current_user_has_permission('action:settings:manage'));

ALTER POLICY item_unit_conversions_manager_insert ON public.item_unit_conversions
 WITH CHECK (public.current_user_has_permission('action:settings:manage'));
ALTER POLICY item_unit_conversions_manager_update ON public.item_unit_conversions
 USING (public.current_user_has_permission('action:settings:manage'))
 WITH CHECK (public.current_user_has_permission('action:settings:manage'));
ALTER POLICY item_unit_conversions_manager_delete ON public.item_unit_conversions
 USING (public.current_user_has_permission('action:settings:manage'));
