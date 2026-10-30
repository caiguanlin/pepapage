package com.pepapage;

import org.mybatis.spring.annotation.MapperScan;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.ConfigurationPropertiesScan;

@SpringBootApplication
@ConfigurationPropertiesScan
@MapperScan("com.pepapage.**.mapper")
public class PepaPageApplication {
    public static void main(String[] args) {
        SpringApplication.run(PepaPageApplication.class, args);
    }
}
