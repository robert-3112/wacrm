export function statusCanalVariant(status: string): 'default' | 'secondary' | 'destructive' {
  if (status === 'ativo') return 'default';
  if (status === 'pausado') return 'secondary';
  return 'destructive';
}
