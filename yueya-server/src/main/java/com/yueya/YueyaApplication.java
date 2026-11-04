package com.yueya;

import org.mybatis.spring.annotation.MapperScan;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.ConfigurationPropertiesScan;

@SpringBootApplication
@ConfigurationPropertiesScan
@MapperScan("com.yueya.**.mapper")
public class YueyaApplication {
    public static void main(String[] args) {
        SpringApplication.run(YueyaApplication.class, args);
    }
}
