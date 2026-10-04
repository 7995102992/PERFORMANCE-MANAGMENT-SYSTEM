package com.sentrifugo.db.mapper;

import com.sentrifugo.db.dto.PmsKraMasterDTO;
import com.sentrifugo.db.entity.PmsKraMasterEntity;
import org.mapstruct.Builder;
import org.mapstruct.Mapper;
import org.mapstruct.Mapping;
import org.mapstruct.MappingTarget;
import org.mapstruct.NullValuePropertyMappingStrategy;
import org.mapstruct.ReportingPolicy;

import java.util.List;

@Mapper(
        componentModel = "spring",
        unmappedTargetPolicy = ReportingPolicy.IGNORE,
        nullValuePropertyMappingStrategy = NullValuePropertyMappingStrategy.IGNORE,
        // Lombok @SuperBuilder entities/DTOs: map through constructor + setters (see PmsCycleMapper).
        builder = @Builder(disableBuilder = true)
)
public interface PmsKraMasterMapper {

    // Parent / referenced entities are resolved and attached by the service, never taken from the DTO.
    PmsKraMasterEntity toEntity(PmsKraMasterDTO dto);

    PmsKraMasterDTO toDTO(PmsKraMasterEntity entity);

    List<PmsKraMasterEntity> toEntityList(List<PmsKraMasterDTO> dtoList);

    List<PmsKraMasterDTO> toDTOList(List<PmsKraMasterEntity> entityList);

    @Mapping(target = "id", ignore = true)
    void updateEntityFromDto(PmsKraMasterDTO dto, @MappingTarget PmsKraMasterEntity entity);
}
