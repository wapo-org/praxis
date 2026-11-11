import React from 'react';
import styles from './TitleText.module.css';
export function TitleText({title}:{title:string}) {
 const [previous,setPrevious]=React.useState(title);
 React.useEffect(()=>{if(previous===title)return;const id=setTimeout(()=>setPrevious(title),300);return()=>clearTimeout(id);},[title,previous]);
 return <span className={styles.stack}><span key={title} className={styles.current}>{title}</span>{previous!==title?<span aria-hidden="true" className={styles.previous}>{previous}</span>:null}</span>;
}
