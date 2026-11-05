

export const load = async ()=>{

    const wait = async ()=>{
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    await wait();
    return { 
        hello:"world"
    }
}